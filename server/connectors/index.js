'use strict';
// The list of sources, in the order they appear in the sidebar.
// To add a new one: create a file in this folder with the same shape and add it here.
const connectors = [
  require('./gmail'),
  require('./outlook'),
  require('./slack'),
  require('./teams'),
  require('./discord'),
  require('./whatsapp'),
  require('./zoom'),
  ...require('./aichats').connectors,
];

const byId = Object.fromEntries(connectors.map((c) => [c.id, c]));
const idsOfKind = (kind) => connectors.filter((c) => c.kind === kind).map((c) => c.id);

module.exports = { connectors, byId, idsOfKind };
