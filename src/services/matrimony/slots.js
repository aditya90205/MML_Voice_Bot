/**
 * Make My Lagan (MML) matrimony intake steps (English).
 * One question at a time → collect → thank you → end call.
 */
export const MATRIMONY_STEPS = Object.freeze([
  {
    id: 'name',
    field: 'name',
    question: 'First, may I know your full name?',
  },
  {
    id: 'gender',
    field: 'gender',
    question: 'Thank you. Are you male or female?',
  },
  {
    id: 'date_of_birth',
    field: 'dateOfBirth',
    question: 'Got it. What is your date of birth? Please share the day, month, and year.',
  },
  {
    id: 'partner_details',
    field: 'partnerDetails',
    question:
      'Now please tell me what you are looking for in a life partner — for example age, city, education, religion, or any other preferences.',
  },
]);

export const MML_GREETING =
  "Hello! I'm calling from Make My Lagan, or MML. We'd like to understand your matrimony requirements. I'll ask a few short questions — please answer one at a time.";

export const MML_THANKS =
  'Thank you so much. Your details have been safely recorded with Make My Lagan. Our team will contact you soon. Best wishes! This call will now end.';

export function createEmptyIntake() {
  return {
    name: null,
    gender: null,
    dateOfBirth: null,
    partnerDetails: null,
    completed: false,
    completedAt: null,
  };
}
