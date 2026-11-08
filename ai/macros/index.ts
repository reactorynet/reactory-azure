import { STATUS_MACROS } from './status.macros';
import { MAIL_MACROS } from './mail.macros';
import { CALENDAR_MACROS } from './calendar.macros';
import { DRIVE_MACROS } from './drive.macros';
import { WORKBOOK_MACROS } from './workbook.macros';
import { CONTACTS_MACROS } from './contacts.macros';
import { TASKS_MACROS } from './tasks.macros';
import { TEAMS_MACROS } from './teams.macros';

/**
 * The module's AI macro surface, assembled from the per-domain arrays.
 *
 * THIS BARREL IS OWNED BY AZ-01 AND EDITED BY NO LATER TICKET. A domain ticket
 * (AZ-13, AZ-14) adds entries to its own `ai/macros/<domain>.macros.ts`; because
 * every array is spread here, the macro appears in AZURE_MACROS without touching
 * this file. That is also why no ticket asserts a whole-array length except the
 * module's final definition of done.
 */
export const AZURE_MACROS: any[] = [
  ...STATUS_MACROS,
  ...MAIL_MACROS,
  ...CALENDAR_MACROS,
  ...DRIVE_MACROS,
  ...WORKBOOK_MACROS,
  ...CONTACTS_MACROS,
  ...TASKS_MACROS,
  ...TEAMS_MACROS,
];

/** Tool definitions exposed alongside the macros. Empty until AZ-13 registers any. */
export const AZURE_TOOLS: any[] = [];

export default AZURE_MACROS;
