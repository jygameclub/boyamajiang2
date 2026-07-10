const GAME_REQUEST_COMMANDS = new Set([
  31008,
  31010,
  40000,
  40002,
  40004,
  40006
]);

export function inferLocalConnectionIndex(firstCommand) {
  return GAME_REQUEST_COMMANDS.has(Number(firstCommand)) ? 1 : 0;
}
