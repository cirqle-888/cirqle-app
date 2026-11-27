/**
 * The Social Calendar remembers the plan a person last OPENED, so coming back
 * to the section returns them to it. A cookie rather than localStorage because
 * the choice is made on the server, before the page renders — reading it in
 * the browser would mean loading one plan and then swapping to another.
 *
 * Scoped to the calendar's own path, so it rides on no other request.
 */
export const LAST_PLAN_COOKIE = 'cirqle_social_last_plan'
export const LAST_PLAN_PATH = '/dashboard/social-calendar'
/** 45 days — long enough to span a month's planning, short enough to forget. */
export const LAST_PLAN_MAX_AGE = 60 * 60 * 24 * 45
