/**
 * The `tiled --evaluate` probe behind tests/automapCanary.test.ts,
 * shared so tests/evaluateScriptTypes.test.ts can typecheck it against
 * the official @mapeditor/tiled-api declarations. Both probes are
 * expected to *throw* on current Tiled — the canary asserts the
 * behaviour, the type test asserts the API surface it drives still
 * exists.
 */
export const AUTOMAP_CANARY_SCRIPT = `
const args = tiled.scriptArguments;
try {
  tiled.open(args[0]);
  tiled.log("CANARY_OPEN_OK");
} catch (error) {
  tiled.log("CANARY_OPEN_ERR: " + error);
}
try {
  const format = tiled.mapFormat("json");
  const map = format.read(args[0]);
  map.autoMap(args[1]);
  tiled.log("CANARY_AUTOMAP_OK");
} catch (error) {
  tiled.log("CANARY_AUTOMAP_ERR: " + error);
}
`;
