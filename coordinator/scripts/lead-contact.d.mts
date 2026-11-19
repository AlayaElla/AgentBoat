import type { ContactRoutes, LeadContact } from '../src/model'
export class LeadContacts {
  constructor(root?: string, script?: string)
  sync(wanted: LeadContact[], executable: string, launch: (args: string[]) => Promise<unknown>, workspaces?: string[]): Promise<ContactRoutes>
}
