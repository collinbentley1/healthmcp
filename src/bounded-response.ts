export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("response body bound must be a positive integer");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} returned an oversized body`);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} returned an oversized body`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} returned an unreadable body`);
  }
}

export async function readBoundedResponseJson(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maxBytes, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned an unreadable body`);
  }
}
