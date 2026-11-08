export { AZURE_MACROS, AZURE_TOOLS } from './macros';

import { AZURE_MACROS, AZURE_TOOLS } from './macros';

/**
 * The module's Reactor contribution.
 *
 * AZ-01 exports the (currently empty) macro and tool arrays so `index.ts` can wire
 * `reactor.macros` from day one; AZ-13 and AZ-14 fill the per-domain arrays and
 * this file never changes again.
 */
export default {
  macros: AZURE_MACROS,
  tools: AZURE_TOOLS,
};
