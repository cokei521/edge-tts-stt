/**
 * Node.js HTTP 适配层 —— 让 Cloudflare Worker 版 index.js 能在普通 Node / Docker 环境运行。
 *
 * 设计原则：不改动 index.js 的业务逻辑，只做协议转换
 *   Node http.IncomingMessage  ->  Web Request
 *   index.js 的 default.fetch(request, env, ctx)
 *   Web Response               ->  Node ServerResponse
 *
 * 依赖的 Web API（fetch / Request / Response / FormData / Blob / crypto.subtle /
 * crypto.randomUUID / atob / btoa）在 Node 18+ 均为内置，无需额外安装任何 npm 包。
 */
import http from 'node:http';
import worker from './index.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
// 转录接口允许 10MB 音频，multipart 编码后会更大，这里给足余量
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 20 * 1024 * 1024);

/** 逐跳（hop-by-hop）请求头，转成 Web Request 时必须丢弃 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

class PayloadTooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new PayloadTooLarge(`请求体超过上限 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Node 请求 -> Web Request */
async function toWebRequest(req) {
  const method = req.method || 'GET';
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null || HOP_BY_HOP.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.append(key, value);
    }
  }

  // 反向代理（Nginx / Traefik 等）场景下优先使用转发头还原真实对外地址
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || process.env.PROTO || (req.socket?.encrypted ? 'https' : 'http');
  const url = `${protocol}://${host}${req.url || '/'}`;

  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await readBody(req);
  }

  return new Request(url, init);
}

/** Web Response -> Node 响应 */
async function sendWebResponse(webResponse, res, method) {
  if (res.writableEnded || res.headersSent) return;

  res.statusCode = webResponse.status;
  res.statusMessage = webResponse.statusText || undefined;

  webResponse.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key)) return;
    // 同名多值头（如 set-cookie）逐条追加，不能合并
    if (key === 'set-cookie') {
      res.appendHeader(key, value);
    } else {
      res.setHeader(key, value);
    }
  });

  const body = Buffer.from(await webResponse.arrayBuffer());

  // Response 自带 content-length 时已被上面复制；缺失时补上，保证 HEAD 也能报出长度
  if (!res.hasHeader('content-length')) {
    res.setHeader('Content-Length', body.length);
  }

  res.end(method === 'HEAD' ? undefined : body);
}

function sendJsonError(res, status, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(
    JSON.stringify({
      error: { message, type: 'api_error', param: null, code: 'server_error' },
    }),
  );
}

// Cloudflare 的 ctx 在本项目里没有被使用，提供最小兼容形状即可
const executionContext = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((err) => console.error('waitUntil 任务失败:', err));
  },
  passThroughOnException() {},
};

// 把进程环境变量作为 env 传入，方便后续用 env 覆盖配置（如 SILICONFLOW_TOKEN）
const env = process.env;

const server = http.createServer(async (req, res) => {
  try {
    const request = await toWebRequest(req);
    const response = await worker.fetch(request, env, executionContext);
    await sendWebResponse(response, res, request.method);
  } catch (error) {
    if (error instanceof PayloadTooLarge) {
      sendJsonError(res, 413, error.message);
    } else {
      console.error('请求处理失败:', error);
      sendJsonError(res, 500, error?.message || '服务内部错误');
    }
  }
});

server.keepAliveTimeout = 65000;
// Worker 侧长文本合成会串行发起多次上游请求，超时放宽
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 300000);
server.headersTimeout = 310000;

server.listen(PORT, HOST, () => {
  console.log(`VoiceCraft 已启动: http://${HOST}:${PORT}`);
  console.log(`TTS:  POST /v1/audio/speech`);
  console.log(`STT:  POST /v1/audio/transcriptions`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`收到 ${signal}，正在关闭服务...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
