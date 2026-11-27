import { z } from 'zod';
import { idSchema, stages } from './contracts';

export type HandoffPerson = { id: string; name: string };
type HandoffWork = { id: string; text: string; due: string | null };

export type HandoffCompany = {
  id: string;
  version: number;
  revision: string;
  name: string;
  formerOwner: HandoffPerson;
  projects: { id: string; name: string; stage: (typeof stages)[number]; due: string | null }[];
  tasks: HandoffWork[];
  candidates: HandoffPerson[];
};

export type HandoffTask = HandoffWork & {
  version: number;
  companyId: string;
  companyName: string;
  formerAssignee: HandoffPerson;
  candidates: HandoffPerson[];
};

export type HandoffQueue = { companies: HandoffCompany[]; tasks: HandoffTask[] };

export type RemovalHandoff = {
  companyCount: number;
  projectCount: number;
  taskCount: number;
  separateTaskCount: number;
  unassignableTaskCount: number;
  candidates: HandoffPerson[];
  suggestedRecipientId: string | null;
  revision: string;
};

export const assignHandoffSchema = z
  .object({ recipientId: idSchema, version: z.number().int().positive() })
  .strict();

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const assignCompanyHandoffSchema = assignHandoffSchema.extend({ revision: revisionSchema });

export const removalHandoffSchema = z
  .object({ recipientId: idSchema.optional(), revision: revisionSchema })
  .strict();
