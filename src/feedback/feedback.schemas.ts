import { z } from 'zod';
import { anyOf, filterDay, fieldFilters, rangesInOrder, yesNo } from '../common/filters.js';
import { DEPARTMENTS, MARKETS, SENTIMENTS, STAY_CHANNELS } from '../db/schema/index.js';
import { UPLOAD_FIELDS } from './feedback-rules.js';

const trimmed = z.string().trim();
const optionalText = trimmed.transform((v) => v || null).nullish();
const date = z.iso.date('Enter a date');
const id = z.number().int().positive();
const rating = z.number().int('Choose 1 to 5 stars').min(1, 'Choose 1 to 5 stars').max(5, 'Choose 1 to 5 stars').nullish();
const review = trimmed.max(10_000).transform((v) => v || null).nullish();

// ---------- a response ----------
// The date received is a day; today means now, an earlier day the start of
// that day in Colombo. Left out, it's now.
export const createFeedbackSchema = z
  .object({ stayId: id, rating, review, receivedOn: date.optional() })
  .refine((v) => v.rating != null || !!v.review, { path: ['rating'], message: 'Enter a rating, a review, or both' });
export type CreateFeedback = z.infer<typeof createFeedbackSchema>;

// The stay can't change: delete the response and add it to the right stay.
// A response left with neither rating nor review is refused in the service.
export const updateFeedbackSchema = z.object({ rating, review, receivedOn: date }).partial();
export type UpdateFeedback = z.infer<typeof updateFeedbackSchema>;

export const followUpSchema = z.object({ outcome: trimmed.min(1, 'Write the outcome').max(2000) });
export type FollowUp = z.infer<typeof followUpSchema>;

export const feedbackNoteSchema = z.object({ body: trimmed.min(1, 'Write the note').max(5000) });
export type FeedbackNote = z.infer<typeof feedbackNoteSchema>;

// ---------- the inbox ----------
export const FEEDBACK_TABS = ['all', 'needs_follow_up', 'followed_up'] as const;
export type FeedbackTab = (typeof FEEDBACK_TABS)[number];

export const FEEDBACK_PAGE_SIZE = 50;

// "Filled in" / "Missing": the response, the stay, and the guest's details for following up.
export const FEEDBACK_FIELDS = [
  'rating',
  'review',
  'bookingReference',
  'stayDates',
  'guestName',
  'guestEmail',
  'guestPhone',
] as const;

export const listFeedbackSchema = z
  .object({
    tab: z.enum(FEEDBACK_TABS).default('all'),
    // a filter with several values matches any of them
    propertyId: anyOf(trimmed.max(10)),
    rating: anyOf(z.coerce.number().int().min(1).max(5)),
    from: date.optional(), // received on or after, a day in Colombo
    to: date.optional(),
    // ---- More filters ----
    q: trimmed.max(100).optional(), // guest name, booking reference or words in the review
    mentions: z.enum(['any', 'praise', 'criticism', 'none']).optional(), // only for roles that see mentions
    contacted: yesNo, // a call or message logged from the response
    stayFrom: filterDay, // the stay's departure
    stayTo: filterDay,
    channel: anyOf(z.enum(STAY_CHANNELS)), // how the stay was booked
    market: anyOf(z.enum(MARKETS)), // the guest's market
    ...fieldFilters(FEEDBACK_FIELDS),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(FEEDBACK_PAGE_SIZE),
  })
  .superRefine(rangesInOrder(['from', 'to'], ['stayFrom', 'stayTo']));
export type ListFeedback = z.infer<typeof listFeedbackSchema>;

// Add response: find the stay by guest name or booking reference.
export const staySearchSchema = z.object({ q: trimmed.min(2, 'Type at least 2 letters').max(100) });
export type StaySearch = z.infer<typeof staySearchSchema>;

// ---------- uploading responses ----------
const uploadRow = z.object(Object.fromEntries(UPLOAD_FIELDS.map((f) => [f, z.string().max(10_000).optional()])) as {
  [K in (typeof UPLOAD_FIELDS)[number]]: z.ZodOptional<z.ZodString>;
});

export const uploadRowsSchema = z.object({ rows: z.array(uploadRow).min(1, 'The file has no responses').max(5000) });
export type UploadRows = z.infer<typeof uploadRowsSchema>;

export const commitUploadSchema = uploadRowsSchema.extend({ fileName: trimmed.min(1).max(255) });
export type CommitUpload = z.infer<typeof commitUploadSchema>;

// ---------- employee mentions ----------
// Linked to an employee, or the name as the guest wrote it until staff can link it.
const mentionFields = {
  employeeId: id.nullish(),
  nameAsWritten: optionalText,
  sentiment: z.enum(SENTIMENTS),
  comment: trimmed.max(5000).transform((v) => v || null).nullish(), // the guest's words
};

export const createMentionSchema = z
  .object(mentionFields)
  .refine((v) => v.employeeId || v.nameAsWritten, { path: ['employeeId'], message: 'Choose the employee or type the name as written' });
export type CreateMention = z.infer<typeof createMentionSchema>;

export const updateMentionSchema = z.object(mentionFields).partial();
export type UpdateMention = z.infer<typeof updateMentionSchema>;

// ---------- employees ----------
const employeeFields = {
  firstName: trimmed.min(1, 'Enter a first name').max(100),
  lastName: optionalText,
  propertyId: trimmed.max(10).transform((v) => v || null).nullish(), // null: works across the group
  department: z.enum(DEPARTMENTS),
  jobTitle: optionalText,
  staffUserId: id.nullish(), // their CRM login, if they have one
};

export const createEmployeeSchema = z.object({ ...employeeFields, department: employeeFields.department.default('other') });
export type CreateEmployee = z.infer<typeof createEmployeeSchema>;

// Leavers are made inactive (isActive false), never deleted.
export const updateEmployeeSchema = z.object({ ...employeeFields, isActive: z.boolean() }).partial();
export type UpdateEmployee = z.infer<typeof updateEmployeeSchema>;

export const EMPLOYEE_STATUSES = ['active', 'inactive', 'all'] as const;

export const listEmployeesSchema = z
  .object({
    q: trimmed.max(100).optional(), // name or job title
    propertyId: anyOf(trimmed.max(10)), // hotel ids, and 'group' for group-wide employees
    department: anyOf(z.enum(DEPARTMENTS)),
    status: z.enum(EMPLOYEE_STATUSES).default('active'),
    // ---- More filters ----
    recent: z.enum(['praised', 'criticised', 'mentioned', 'none']).optional(), // guests' mentions in the last 90 days
    lastMentionedFrom: filterDay, // a day in Colombo
    lastMentionedTo: filterDay,
    ...fieldFilters(['lastName', 'jobTitle', 'login']), // login = linked to a CRM login
  })
  .superRefine(rangesInOrder(['lastMentionedFrom', 'lastMentionedTo']));
export type ListEmployees = z.infer<typeof listEmployeesSchema>;

// The picker on a mention: active employees of this hotel first.
export const employeeOptionsSchema = z.object({ propertyId: trimmed.max(10).optional() });
export type EmployeeOptions = z.infer<typeof employeeOptionsSchema>;

// A hotel's staff list from a spreadsheet.
const staffRow = z.object({
  name: z.string().max(300).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(200).optional(),
  department: z.string().max(100).optional(),
  jobTitle: z.string().max(200).optional(),
});

export const staffListSchema = z.object({
  propertyId: trimmed.max(10).transform((v) => v || null).nullable(), // null: group-wide
  rows: z.array(staffRow).min(1, 'The file has no names').max(2000),
});
export type StaffList = z.infer<typeof staffListSchema>;
