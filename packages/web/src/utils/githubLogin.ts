// GitHub ユーザー名の入力ゆれ（@ 付き・URL）を吸収して検証する

const LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;

export const normalizeLogin = (value: string): string =>
  value.trim().replace(/^@/, "").replace(/^https?:\/\/github\.com\//i, "").replace(/\/.*$/, "");

export const isValidLogin = (value: string): boolean => LOGIN_PATTERN.test(value);
