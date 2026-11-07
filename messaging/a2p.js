/**
 * The public A2P 10DLC registration form at netenroll.com/a2p-registration.
 *
 * Answers are kept as one JSON document rather than a column each: nothing
 * queries them, and the questions change whenever the carriers' do. The option
 * lists below are what tools/check-site.mjs compares against the page.
 */
'use strict';

const YES_NO = ['Yes', 'No'];

const A2P_OPTIONS = {
  entity_type: ['LLC', 'Corporation', 'Partnership', 'Sole Proprietor', 'Nonprofit', 'Other'],
  ownership_type: ['Privately owned', 'Publicly traded', 'Nonprofit', 'Government'],
  industry: ['Agriculture', 'Automotive', 'Banking and Financial Services', 'Construction and Trades', 'Consumer Services',
    'Education', 'Energy and Utilities', 'Entertainment', 'Government', 'Healthcare', 'Hospitality and Travel', 'Insurance',
    'Legal', 'Manufacturing', 'Nonprofit', 'Professional Services', 'Real Estate', 'Retail and E-commerce', 'Technology',
    'Telecommunications', 'Transportation and Logistics', 'Other'],
  address_state: ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
    'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'PR',
    'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'],
  has_links: YES_NO,
  has_phone_numbers: YES_NO,
  daily_volume: ['Under 100', '100 to 500', '500 to 2,000', '2,000 to 10,000', 'More than 10,000'],
  allows_replies: YES_NO,
  screenshot_choice: ['Upload now', 'Send it later'],
  list_source: ['Collected directly by us', 'Obtained from third parties', 'Both'],
  keeps_records: YES_NO,
  prior_registration: YES_NO,
  number_source: ['Use existing numbers', 'Purchase new numbers', 'Both']
};

const A2P_MULTI = {
  use_cases: ['Marketing', 'Sales Follow-Ups', 'Customer Service', 'Appointment Reminders', 'Notifications', 'Verification Codes', 'Other'],
  recipients: ['Current customers', 'Leads who requested information', 'Members or subscribers', 'Employees or staff', 'Other'],
  consent_methods: ['Website Form', 'Text Keyword', 'Written Consent', 'Verbal Consent', 'Other']
};

// Every free-text answer and its length cap. Blank is allowed here; REQUIRED
// and the conditional rules in validateA2p decide what must be present.
const TEXT_FIELDS = {
  legal_name: 200, dba_name: 200, entity_other: 100, ein: 10, industry_other: 100, business_description: 1000, website: 300,
  address_street: 200, address_line2: 100, address_city: 100, address_zip: 10,
  rep_name: 200, rep_title: 100, rep_email: 254, rep_phone: 40,
  sms_brand: 100, use_case_other: 200, message_description: 1000, recipients_other: 200,
  sample_1: 1000, sample_2: 1000, sample_3: 1000, link_domains: 500,
  consent_other: 200, optin_url: 300, consent_language: 2000,
  privacy_url: 300, terms_url: 300, support_contact: 254, prior_provider: 100
};

const REQUIRED = ['legal_name', 'business_description', 'website', 'address_street', 'address_city', 'address_zip',
  'rep_name', 'rep_title', 'rep_email', 'rep_phone', 'sms_brand', 'message_description', 'sample_1', 'sample_2', 'sample_3',
  'consent_language', 'privacy_url', 'terms_url', 'support_contact'];

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isPhone = (v) => /^[\d\s()+.-]+$/.test(v) && v.replace(/\D/g, '').length >= 10;
const label = (key) => key.replace(/_/g, ' ');

function isUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.');
  } catch { return false; }
}

/** A screenshot arrives as a data URL. Trust the bytes, not the declared type. */
function decodeScreenshot(value) {
  const m = /^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) return null;
  const data = Buffer.from(m[1], 'base64');
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { data, type: 'image/jpeg' };
  if (data.subarray(0, 4).toString('latin1') === '\x89PNG') return { data, type: 'image/png' };
  return null;
}

function validateA2p(body) {
  const a = {};
  for (const [key, max] of Object.entries(TEXT_FIELDS)) a[key] = typeof body[key] === 'string' ? body[key].trim().slice(0, max) : '';
  for (const key of Object.keys(A2P_OPTIONS)) a[key] = typeof body[key] === 'string' ? body[key].trim() : '';
  for (const key of Object.keys(A2P_MULTI)) a[key] = Array.isArray(body[key]) ? body[key].filter(v => typeof v === 'string') : [];
  a.number_count = Number(body.number_count);

  const bad = (error) => ({ ok: false, error });

  for (const key of REQUIRED) if (!a[key]) return bad(`${label(key)} is required`);
  for (const [key, allowed] of Object.entries(A2P_OPTIONS)) {
    if (!allowed.includes(a[key])) return bad(`${label(key)} is not one of the offered choices`);
  }
  for (const [key, allowed] of Object.entries(A2P_MULTI)) {
    if (!a[key].length || !a[key].every(v => allowed.includes(v))) return bad(`Choose at least one option for ${label(key)}`);
  }

  // A sole proprietor is the one registration type with no EIN.
  if (a.entity_type !== 'Sole Proprietor' && !a.ein) return bad('ein is required');
  if (a.ein && !/^\d{2}-?\d{7}$/.test(a.ein)) return bad('The EIN must be 9 digits');
  if (!/^\d{5}(-\d{4})?$/.test(a.address_zip)) return bad('A valid ZIP code is required');
  if (!isEmail(a.rep_email)) return bad('A valid email address is required');
  if (!isPhone(a.rep_phone)) return bad('A valid phone number is required');
  if (!isEmail(a.support_contact) && !isPhone(a.support_contact)) return bad('Support contact must be an email address or phone number');
  for (const key of ['website', 'privacy_url', 'terms_url']) if (!isUrl(a[key])) return bad(`${label(key)} must be a full web address`);
  if (a.optin_url && !isUrl(a.optin_url)) return bad('optin url must be a full web address');
  if (a.consent_methods.includes('Website Form') && !a.optin_url) return bad('optin url is required for a website form');
  if (a.has_links === 'Yes' && !a.link_domains) return bad('link domains is required');
  if (a.prior_registration === 'Yes' && !a.prior_provider) return bad('prior provider is required');
  if (!Number.isInteger(a.number_count) || a.number_count < 1 || a.number_count > 1000) return bad('number count must be between 1 and 1000');
  if (body.certified !== true) return bad('Please confirm the information is accurate');

  let shot = null;
  if (a.screenshot_choice === 'Upload now') {
    shot = typeof body.screenshot === 'string' ? decodeScreenshot(body.screenshot) : null;
    if (!shot) return bad('The screenshot must be a PNG or JPG image');
  }
  return { ok: true, answers: a, shot };
}

/**
 * The notification. The EIN stays out of it: email is stored in plain text in
 * more places than this database is. The full record is behind the login.
 */
function summaryText(a, id) {
  const lines = { ...a, ein: a.ein ? `***${a.ein.slice(-4)}` : '(none)' };
  return [
    ...Object.entries(lines)
      .filter(([, v]) => v !== '' && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${label(k)}: ${Array.isArray(v) ? v.join(', ') : v}`),
    '',
    `Full record, with the EIN and any screenshot: https://messaging.netenroll.com/api/a2p-registrations/${id}`
  ].join('\n');
}

module.exports = { A2P_OPTIONS, A2P_MULTI, validateA2p, summaryText };
