import { mergeGraphResolver } from '@reactory/server-core/utils';
import AuthResolver from './AuthResolver';
import MailResolver from './MailResolver';
import TasksResolver from './TasksResolver';
import CalendarResolver from './CalendarResolver';
import DriveResolver from './DriveResolver';
import DocumentsResolver from './DocumentsResolver';
import WorkbookResolver from './WorkbookResolver';
import ContactsResolver from './ContactsResolver';
import TeamsResolver from './TeamsResolver';
import SharePointResolver from './SharePointResolver';
import SyncResolver from './SyncResolver';

/**
 * Every resolver the module contributes.
 *
 * AZ-01 owns this barrel: all eleven resolvers are listed up front (Auth is
 * implemented, the rest are stubs that throw), so a later ticket never edits it.
 */
export default mergeGraphResolver([
  AuthResolver,
  MailResolver,
  TasksResolver,
  CalendarResolver,
  DriveResolver,
  DocumentsResolver,
  WorkbookResolver,
  ContactsResolver,
  TeamsResolver,
  SharePointResolver,
  SyncResolver,
]);
