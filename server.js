const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: 'https://www.pathtopossibilities.co.uk', // your real Squarespace domain
  methods: ['POST'],
}));

// ---------------- CONFIG ----------------
// Use api.staging.justgiving.com while testing, api.justgiving.com once live
const JG_API_BASE = process.env.JUSTGIVING_API_BASE || 'https://api.staging.justgiving.com';
const JG_APP_ID = process.env.JUSTGIVING_APP_ID;
const JG_CHARITY_ID = process.env.JUSTGIVING_CHARITY_ID;
const JG_EVENT_ID = process.env.JUSTGIVING_EVENT_ID; // optional
const JG_CAMPAIGN_GUID = process.env.JUSTGIVING_CAMPAIGN_GUID; // optional
// Read from env so this always matches followup.js's milestone math —
// change it in one place (your .env / Render env vars), not two files.
const FUNDRAISING_TARGET = process.env.FUNDRAISING_TARGET || "500";

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_CONVERSIONS_API_TOKEN;

console.log('META CONFIG:', {
  pixelId: META_PIXEL_ID ? 'SET' : 'MISSING',
  accessToken: META_ACCESS_TOKEN ? 'SET' : 'MISSING'
});

const KLAVIYO_PRIVATE_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// In-memory guard against double-submits within a single server instance.
// NOTE: this resets on every deploy/restart and won't catch duplicates across
// multiple instances if you ever scale beyond one Render dyno. The Sheet
// check in isDuplicateEmail() below is the durable source of truth.
const recentSubmissions = new Set();

// ---------------- DUPLICATE CHECK: has this email already claimed/started a page? ----------------
async function findExistingSignup(email) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Tracker!A:J',
  });
  const rows = response.data.values || [];
  // Column B (index 1) is Email, Column E (index 4) is Claim link
  const match = rows.find(
    (row) => (row[1] || '').trim().toLowerCase() === email.trim().toLowerCase()
  );
  if (!match) return null;
  return { claimUrl: match[4], pageShortName: match[9] };
}

// ---------------- STEP 1: create the unclaimed JustGiving page ----------------
async function createUnclaimedPage(lead) {
  const story = "I'm taking part in Hike for Change to help send " +
    "out-of-school children in Nigeria back into education. Every " +
    "step and every pound raised gets a child closer to the classroom. " +
    "Please support me!";

  // JustGiving shortnames have a length cap. Truncate each name part so the
  // full string (name + "-hike-" + 13-digit timestamp) stays safely under it.
  const safe = (s) => (s || '').trim().slice(0, 20);
  const pageShortName = `${safe(lead.firstName)}-${safe(lead.lastName)}-hike-${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-');

  const payload = {
    email: lead.email,
    firstName: lead.firstName,
    lastName: lead.lastName,
    charityId: Number(JG_CHARITY_ID),
    eventId: JG_EVENT_ID ? Number(JG_EVENT_ID) : null, // omit/null if no registered event
    campaignGuid: JG_CAMPAIGN_GUID || null,
    pageShortName,
    pageTitle: 'My Hike for Change Fundraising Page',
    // activityType + eventName are required whenever eventId is not set.
    // Confirmed against JustGiving's actual validation errors during testing.
    activityType: JG_EVENT_ID ? null : 'Treks',
    eventName: JG_EVENT_ID ? null : 'Hike for Change',
    targetAmount: FUNDRAISING_TARGET,
    charityOptIn: true,
    charityFunded: false,
    pageStory: story,
    currency: 'GBP',
    reference: `hikeforchange-${Date.now()}`,
  };

  // NOTE: confirmed with JustGiving developer support (Aug 2026) — this
  // endpoint takes NO authentication at creation time. Do not send an
  // Authorization header; it causes the request to fail. Authentication
  // happens later, when the supporter clicks their claim link.
  const response = await axios.put(
    `${JG_API_BASE}/${JG_APP_ID}/v1/fundraising/unclaimedpages`,
    payload,
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );

  console.log('JUSTGIVING RESPONSE:', JSON.stringify(response.data, null, 2));

  // Immediately capture the page's starting consumerId. JustGiving's own
  // Claim API docs confirm: "the page will then be re-associated to their
  // consumerId" once claimed. Capturing this baseline right now, before any
  // chance of a real claim happening, is what lets followup.js later detect
  // a claim by checking whether consumerId has changed from this value.
  let initialConsumerId = null;
  try {
    const statusRes = await axios.get(
      `${JG_API_BASE}/${JG_APP_ID}/v1/fundraising/pages/${payload.pageShortName}`
    );
    initialConsumerId = statusRes.data.consumerId;
  } catch (err) {
    console.error('Could not capture initial consumerId (non-fatal):', err.message);
  }

  // response.data includes: claimToken, pageGuid, signOnUrl, next.url (the claim link)
  return {
    claimUrl: response.data.signOnUrl,
    pageShortName: payload.pageShortName,
    pageGuid: response.data.pageGuid,
    initialConsumerId,
  };
}

// ---------------- STEP 2: log to Google Sheet ----------------
async function logToSheet(lead, claimData) {
  const row = [
    `${lead.firstName} ${lead.lastName}`,  // A: Lead name
    lead.email,                                 // B: Email
    lead.phone || '',                           // C: Phone
    new Date().toISOString(),                   // D: Date lead captured
    claimData.claimUrl,                         // E: Claim link
    'Sent',                                      // F: Claim link sent status
    'No',                                         // G: Claimed? (Y/N)
    '',                                            // H: Date claimed
    0,                                              // I: Amount raised
    claimData.pageShortName,                        // J: Page short name
    '',                                               // K: Milestones Sent (filled later)
    '',                                                // L: No-Raise Reminders Sent (filled later)
    claimData.initialConsumerId ?? '',                  // M: Initial Consumer ID (claim-detection baseline)
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Tracker!A:M',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// ---------------- STEP 3: fire Meta Conversions API event ----------------
function hashSHA256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

// Meta expects phone numbers as digits only (E.164 without the leading '+').
function normalizePhoneForMeta(phone) {
  return phone.replace(/[^\d]/g, '');
}

async function fireMetaEvent(eventName, lead, extraData = {}, eventId = undefined) {
  // Check that Meta credentials exist
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    console.warn(
      `META CONFIG MISSING - Skipping ${eventName} event`
    );
    return;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`,
      {
        data: [{
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          // event_id lets Meta de-duplicate this server-side event against
          // the client-side fbq() call fired from the same signup.
          ...(eventId ? { event_id: eventId } : {}),
          user_data: {
            em: [hashSHA256(lead.email)],
            ph: lead.phone
              ? [hashSHA256(normalizePhoneForMeta(lead.phone))]
              : undefined,
          },
          custom_data: extraData,
        }],
        access_token: META_ACCESS_TOKEN,
      }
    );

    console.log(`META SUCCESS: ${eventName}`, response.data);

  } catch (error) {
    console.error(
      `META ERROR: ${eventName}`,
      error.response?.data || error.message
    );
    // Don't stop the signup process if Meta fails — errors here are
    // swallowed by design; caller does not need to handle rejection.
  }
}

// ---------------- STEP 4: send claim event to Klaviyo ----------------
async function sendClaimEmail(lead, claimUrl, pageShortName) {
  console.log('KLAVIYO: Starting...');

  if (!KLAVIYO_PRIVATE_API_KEY) {
    throw new Error('KLAVIYO_PRIVATE_API_KEY is not configured');
  }

  if (!lead.email) {
    throw new Error('Lead email is required for Klaviyo');
  }

  const response = await axios.post(
    'https://a.klaviyo.com/api/events',
    {
      data: {
        type: 'event',
        attributes: {
          metric: {
            data: {
              type: 'metric',
              attributes: {
                name: 'ClaimLinkSent'
              }
            }
          },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email: lead.email,
                first_name: lead.firstName,
                last_name: lead.lastName,
                ...(lead.phone ? {
                  phone_number: lead.phone
                } : {})
              }
            }
          },
          properties: {
            claim_url: claimUrl,
            page_short_name: pageShortName,
            page_title: 'My Hike for Change Fundraising Page',
            campaign: 'Hike for Change'
          },
          time: new Date().toISOString(),
          unique_id: `claim-link-${pageShortName}`
        }
      }
    },
    {
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_PRIVATE_API_KEY}`,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/json',
        'Revision': '2026-07-15'
      }
    }
  );

  console.log('KLAVIYO SUCCESS:', response.status);
}

// Health check
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Hike for Change backend is running'
  });
});

// ---------------- MAIN SIGNUP ENDPOINT ----------------
app.post('/api/signup', async (req, res) => {
  const lead = req.body; // { firstName, lastName, email, phone, consent, metaEventId }

  if (!lead.consent) {
    return res.status(400).json({ error: 'Consent required' });
  }
  if (!lead.email || !lead.firstName || !lead.lastName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const emailKey = lead.email.trim().toLowerCase();

  // Fast in-memory guard against accidental double-clicks within this process.
  if (recentSubmissions.has(emailKey)) {
    return res.status(409).json({ error: 'Signup already in progress for this email' });
  }
  recentSubmissions.add(emailKey);
  setTimeout(() => recentSubmissions.delete(emailKey), 60_000);

  try {
    // Durable check: has this email already got a page, from a previous session?
    console.log('STEP 0: Checking for existing signup...');
    const existing = await findExistingSignup(emailKey).catch((err) => {
      console.error('DUPLICATE CHECK ERROR (continuing anyway):', err.message);
      return null; // don't block signup if the Sheet check itself fails
    });

    if (existing && existing.claimUrl) {
      console.log('STEP 0: Existing signup found, returning saved claim link.');
      return res.status(200).json({ success: true, claimUrl: existing.claimUrl, alreadyExisted: true });
    }

    console.log('STEP 1: Creating JustGiving page...');
    const claimData = await createUnclaimedPage(lead);
    console.log('STEP 1 SUCCESS:', claimData);

    // From here on, failures are logged but must NOT fail the signup —
    // the supporter already has a real JustGiving page at this point.
    const results = await Promise.allSettled([
      logToSheet(lead, claimData),
      fireMetaEvent('Lead', lead, {}, lead.metaEventId),
      fireMetaEvent('ClaimLinkSent', lead, {
        page: claimData.pageShortName,
        claimUrl: claimData.claimUrl
      }),
      sendClaimEmail(lead, claimData.claimUrl, claimData.pageShortName),
    ]);

    const stepNames = ['logToSheet', 'fireMetaEvent:Lead', 'fireMetaEvent:ClaimLinkSent', 'sendClaimEmail'];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`STEP FAILED (non-blocking): ${stepNames[i]}:`, r.reason?.message || r.reason);
      } else {
        console.log(`STEP SUCCESS: ${stepNames[i]}`);
      }
    });

    res.status(200).json({
      success: true,
      claimUrl: claimData.claimUrl
    });

  } catch (err) {
    // Only reaches here if createUnclaimedPage itself failed — the one step
    // that genuinely must succeed for the signup to mean anything.
    console.error('SIGNUP ERROR:', err);
    console.error('STACK:', err.stack);

    res.status(500).json({
      error: 'Something went wrong. Please try again.'
    });
  } finally {
    recentSubmissions.delete(emailKey);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// Starts the every-6-hours lifecycle check: claim detection, fundraising
// milestone emails, and the "haven't started raising" nudges. Lives in
// followup.js — must be in the same folder as this file.
require('./followup')();