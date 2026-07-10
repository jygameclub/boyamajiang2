export const DEFAULT_LOCAL_USER_TOKEN = "local-default";
export const DEFAULT_LOCAL_USER_BALANCE = 100_000_000;

const LOCAL_USER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeLocalUserToken(value, { useDefault = true } = {}) {
  const token = String(value ?? "").trim();
  if (!token && useDefault) return DEFAULT_LOCAL_USER_TOKEN;
  if (!LOCAL_USER_TOKEN_PATTERN.test(token)) {
    const error = new Error("LOCAL_USER_TOKEN_INVALID");
    error.statusCode = 400;
    throw error;
  }
  return token;
}

export function normalizeGatewayUserToken(value) {
  return normalizeLocalUserToken(String(value ?? "").split("?")[0]);
}
