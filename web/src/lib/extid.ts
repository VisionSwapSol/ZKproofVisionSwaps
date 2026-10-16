/** A Chrome extension ID: 32 letters a to p. */
const EXT_ID = /^[a-p]{32}$/;

/**
 * Which extension ID the open account may be handed to. With an ID built into the page (`pinned`),
 * only that one, and only while the server names the same one (a server naming another is not
 * followed, and nothing is offered); with none built in, the one the server names.
 */
export function extensionIdFrom(server: unknown, pinned: string): string | null {
  const said = typeof server === "string" && EXT_ID.test(server) ? server : null;
  if (EXT_ID.test(pinned)) return said === pinned ? pinned : null;
  return said;
}
