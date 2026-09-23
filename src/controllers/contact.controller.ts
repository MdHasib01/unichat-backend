import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../utils/response';
import {
  addContactNote,
  createContact,
  deleteContact,
  getContact,
  listContacts,
  setContactTags,
  updateContact,
} from '../services/contact.service';
import { auditFromRequest } from '../services/audit.service';

export async function listContactsController(req: Request, res: Response) {
  const query = req.query as unknown as {
    page: number;
    pageSize: number;
    search?: string;
    platform?: never;
    tagId?: string;
    sort?: 'recent' | 'name' | 'created';
  };
  const { items, total } = await listContacts(req.tenant!.organizationId, query);
  return paginated(res, items, query.page, query.pageSize, total);
}

export async function getContactController(req: Request, res: Response) {
  return ok(res, await getContact(req.tenant!.organizationId, req.params.id));
}

export async function createContactController(req: Request, res: Response) {
  const contact = await createContact(req.tenant!.organizationId, req.body);
  await auditFromRequest(req, 'contact.created', { entityType: 'Contact', entityId: contact.id });
  return created(res, contact, 'Contact created');
}

export async function updateContactController(req: Request, res: Response) {
  const contact = await updateContact(req.tenant!.organizationId, req.params.id, req.body);
  await auditFromRequest(req, 'contact.updated', { entityType: 'Contact', entityId: req.params.id });
  return ok(res, contact, 'Contact updated');
}

export async function deleteContactController(req: Request, res: Response) {
  await deleteContact(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'contact.deleted', { entityType: 'Contact', entityId: req.params.id });
  return noContent(res);
}

export async function addContactNoteController(req: Request, res: Response) {
  const note = await addContactNote(
    req.tenant!.organizationId,
    req.params.id,
    req.auth!.userId,
    req.body.body,
  );
  return created(res, note, 'Note added');
}

export async function setContactTagsController(req: Request, res: Response) {
  const contact = await setContactTags(req.tenant!.organizationId, req.params.id, req.body.tagIds);
  return ok(res, contact, 'Tags updated');
}
