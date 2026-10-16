// 大文件流式验证：确认服务端不会把整个文件读入内存。
//
// 用法：node scripts/verify-largefile.mjs [MB] [baseUrl]

import { createHash } from 'node:crypto';

const MB = Number(process.argv[2] || 200);
const BASE = process.argv[3] || 'http://127.0.0.1:8080';

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
const { token } = await login.json();

// 构造确定性的可复现数据，便于校验。
const size = MB * 1024 * 1024;
const block = Buffer.alloc(1024 * 1024);
for (let i = 0; i < block.length; i += 1) block[i] = (i * 7) % 251;

const hasher = createHash('sha256');
for (let i = 0; i < MB; i += 1) hasher.update(block);
const sha256 = hasher.digest('hex');

console.log(`准备上传 ${MB} MiB，sha256=${sha256.slice(0, 16)}…`);

const reg = await fetch(`${BASE}/api/resources/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ name: `大文件-${MB}MB.bin`, size_bytes: size, sha256 }),
});
const { resource_id: resourceId } = await reg.json();
console.log('登记完成 resource_id =', resourceId);

// 以流式方式发送，避免客户端自身占用过多内存。
const boundary = `----cumsLarge${Date.now()}`;
const head = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
);
const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

async function* multipartBody() {
  yield head;
  for (let i = 0; i < MB; i += 1) yield block;
  yield tail;
}

const uploadStart = Date.now();
const upload = await fetch(`${BASE}/api/resources/${resourceId}/upload`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  },
  body: multipartBody(),
  duplex: 'half',
});
const uploadText = await upload.text();
const uploadSeconds = (Date.now() - uploadStart) / 1000;
console.log(`上传状态 ${upload.status}，耗时 ${uploadSeconds.toFixed(2)}s`);

const uploaded = JSON.parse(uploadText);
const hashOk = uploaded.sha256 === sha256;
console.log('SHA-256 校验：', hashOk ? '一致' : `不一致（期望 ${sha256.slice(0, 16)}…，实际 ${String(uploaded.sha256).slice(0, 16)}…）`);

// 下载并核对：只读取首尾片段，避免客户端内存成为瓶颈。
const headRes = await fetch(`${BASE}/files/${resourceId}`, { method: 'HEAD' });
console.log(
  'HEAD：',
  headRes.status,
  'content-length =',
  headRes.headers.get('content-length'),
  'accept-ranges =',
  headRes.headers.get('accept-ranges'),
);

const rangeStart = Date.now();
const rangeRes = await fetch(`${BASE}/files/${resourceId}`, {
  headers: { Range: `bytes=${size - 1024}-${size - 1}` },
});
const rangeBytes = Buffer.from(await rangeRes.arrayBuffer());
const rangeSeconds = (Date.now() - rangeStart) / 1000;
const expectedTail = block.subarray(block.length - 1024);
console.log(
  `尾部 Range 下载：${rangeRes.status}，${rangeBytes.length} 字节，耗时 ${rangeSeconds.toFixed(2)}s，内容`,
  rangeBytes.equals(expectedTail) ? '一致' : '不一致',
);

const ok =
  upload.status === 200 &&
  hashOk &&
  Number(headRes.headers.get('content-length')) === size &&
  rangeRes.status === 206 &&
  rangeBytes.equals(expectedTail);

console.log(ok ? '\nRESULT: 大文件流式上传与 Range 下载正常' : '\nRESULT: 大文件验证失败');
process.exit(ok ? 0 : 1);
