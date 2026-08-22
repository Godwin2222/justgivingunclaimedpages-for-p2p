// followup.js
//
// The scheduled "lifecycle" job. Runs every 6 hours inside the same
// process as server.js. For every lead in the Tracker sheet that isn't
// finished yet (hasn't claimed OR hasn't hit 100%), it:
//
//   1. Checks JustGiving for claim status + amount raised
//   2. Updates the Google Sheet
//   3. Updates the person's Klaviyo profile (page_claimed, percent_raised)
//   4. Fires a Klaviyo event on claim, and one per newly-crossed milestone
//   5. Fires the Meta "PageClaimed" event so they drop out of retargeting
//
// IMPORTANT — before wiring this into production:
// The GET endpoint below (`/v1/fundraising/pages/{pageShortName}`) has NOT
// been verified against a real response the way your PUT (create page)
// endpoint was in Postman. Run one test call against a real staging page,
// log the full response, and confirm the actual field names for "claimed"
// and "amount raised" — then adjust extractPageStats() below. Do this the
// same way you did the Postman spike in Section 5.3 of the guide, before
// trusting this job with real donor data.

const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');

const JG_API_BASE = process.env.JUSTGIVING_API_BASE || 'https://api.justgiving.com';
const FUNDRAISING_TARGET = Number(process.env.FUNDRAISING_TARGET || 500);

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_CONVERSIONS_API_TOKEN;
const KLAVIYO_PRIVATE_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Order matters — checked low to high so multiple milestones crossed
// between checks (e.g. a big single donation) all get sent at once.
const MILESTONES = [5, 10, 20, 25, 50, 75, 100];

// "You haven't started raising yet" nudges — fires only while raisedAmount
// is still 0, at each of these day-marks since signup. Independent of the
// claim reminder (which is about claiming the page) and the milestone
// emails (which only start once they've raised something).
const NO_RAISE_DAY_MARKS = [3, 7, 14];

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

function hashSHA256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

// ---------------- JustGiving: read claim + amount status ----------------
// TODO: confirm real field names via Postman before trusting this in prod.
// Candidates are tried in order; whichever your test call actually returns,
// trim this down to just that one.
async function fetchPageStats(pageShortName) {
  const { data } = await axios.get(
    `${JG_API_BASE}/v1/fundraising/pages/${pageShortName}`
  );

  const claimed =
    data.status === 'Claimed' ||
    data.hasBeenClaimed === true ||
    data.pageStatus === 'Claimed' ||
    false;

  const raisedAmount =
    data.grandTotalRaisedIncTax ??
    data.raisedAmount ??
    data.totalRaised ??
    data.summary?.totalRaisedOnJustGiving ??
    0;

  return { claimed, raisedAmount: Number(raisedAmount) || 0 };
}

// ---------------- Meta Conversions API ----------------
async function fireMetaEvent(eventName, lead, extraData = {}) {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`,
      {
        data: [{
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          user_data: {
            em: [hashSHA256(lead.email)],
            ph: lead.phone ? [hashSHA256(lead.phone.replace(/^\+/, ''))] : undefined,
          },
          custom_data: extraData,
        }],
        access_token: META_ACCESS_TOKEN,
      }
    );
    console.log(`META SUCCESS (followup): ${eventName}`);
  } catch (error) {
    console.error(`META ERROR (followup): ${eventName}`, error.response?.data || error.message);
  }
}

// ---------------- Klaviyo: fire an event + update profile properties ----------------
async function sendKlaviyoEvent(metricName, lead, properties = {}, profileProperties = {}) {
  if (!KLAVIYO_PRIVATE_API_KEY) {
    console.warn('KLAVIYO CONFIG MISSING - skipping', metricName);
    return;
  }

  await axios.post(
    'https://a.klaviyo.com/api/events',
    {
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: metricName } } },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email: lead.email,
                first_name: lead.firstName,
                last_name: lead.lastName,
                properties: profileProperties, // persists onto the profile
              },
            },
          },
          properties, // attached to this event only
          time: new Date().toISOString(),
          unique_id: `${metricName}-${lead.pageShortName}-${properties.milestone_percent || ''}`,
        },
      },
    },
    {
      headers: {
        Authorization: `Klaviyo-API-Key ${KLAVIYO_PRIVATE_API_KEY}`,
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/json',
        Revision: '2026-07-15',
      },
    }
  );
  console.log(`KLAVIYO SUCCESS (followup): ${metricName}`);
}

// ---------------- Google Sheet helpers ----------------
async function getAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    // K = Milestones Sent, L = No-Raise Reminders Sent (both new columns)
    range: 'Tracker!A:L',
  });
  return res.data.values || [];
}

async function updateSheetRow(rowNumber, updates) {
  // updates: { G: 'Yes', H: isoDate, I: amount, K: '5,10,25' }
  const requests = Object.entries(updates).map(([col, value]) => ({
    range: `Tracker!${col}${rowNumber}`,
    values: [[value]],
  }));
  if (requests.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data: requests },
  });
}

// ---------------- Main job ----------------
async function runFollowUpCheck() {
  console.log('Running follow-up check...');
  const rows = await getAllRows();
  const dataRows = rows.slice(1); // skip header row

  for (let i = 0; i < dataRows.length; i++) {
    const rowNumber = i + 2; // +2: 1-indexed + header row
    const [
      name, email, phone, dateCaptured, claimUrl,
      sentStatus, claimedFlag, dateClaimed, amountRaised,
      pageShortName, milestonesSentRaw, noRaiseSentRaw
    ] = dataRows[i];

    const milestonesSent = (milestonesSentRaw || '').split(',').filter(Boolean).map(Number);
    const noRaiseRemindersSent = (noRaiseSentRaw || '').split(',').filter(Boolean).map(Number);

    // Row is fully done — 100% raised AND all no-raise nudges are moot — skip forever.
    if (milestonesSent.includes(100)) continue;
    if (!pageShortName) continue; // malformed row, skip safely

    const [firstName] = (name || '').split(' ');
    const lead = { firstName, lastName: (name || '').split(' ').slice(1).join(' '), email, phone, pageShortName };

    let stats;
    try {
      stats = await fetchPageStats(pageShortName);
    } catch (err) {
      console.error(`Follow-up: failed to fetch stats for ${pageShortName}:`, err.message);
      continue; // don't let one bad row stop the whole batch
    }

    const updates = {};
    const wasClaimed = claimedFlag === 'Yes';

    // ---- 1. Detect a fresh claim ----
    if (stats.claimed && !wasClaimed) {
      updates.G = 'Yes';
      updates.H = new Date().toISOString();

      await Promise.allSettled([
        fireMetaEvent('PageClaimed', lead, { page: pageShortName }),
        sendKlaviyoEvent('PageClaimed', lead, { page_short_name: pageShortName, claim_url: claimUrl }, { page_claimed: true }),
      ]);
    }

    // ---- 2. Update raised amount + check milestones (keeps running post-claim) ----
    if (stats.raisedAmount !== Number(amountRaised || 0)) {
      updates.I = stats.raisedAmount;
    }

    const percentRaised = Math.floor((stats.raisedAmount / FUNDRAISING_TARGET) * 100);
    const newlyCrossed = MILESTONES.filter((m) => percentRaised >= m && !milestonesSent.includes(m));

    if (newlyCrossed.length > 0) {
      for (const milestone of newlyCrossed) {
        await sendKlaviyoEvent(
          'FundraisingMilestoneReached',
          lead,
          {
            milestone_percent: milestone,
            amount_raised: stats.raisedAmount,
            target_amount: FUNDRAISING_TARGET,
            page_short_name: pageShortName,
            claim_url: claimUrl,
          },
          { percent_raised: percentRaised }
        );
      }
      updates.K = [...milestonesSent, ...newlyCrossed].join(',');
    }

    // ---- 3. "Haven't started raising yet" nudges (3 / 7 / 14 days since signup) ----
    // Only relevant while raisedAmount is still literally 0 — the moment they
    // raise anything at all, this track stops forever (milestones take over).
    if (stats.raisedAmount === 0) {
      const daysSinceSignup = Math.floor((Date.now() - new Date(dateCaptured)) / (1000 * 60 * 60 * 24));
      const newlyDueNudges = NO_RAISE_DAY_MARKS.filter(
        (mark) => daysSinceSignup >= mark && !noRaiseRemindersSent.includes(mark)
      );

      for (const dayMark of newlyDueNudges) {
        await sendKlaviyoEvent(
          'NoFundraisingActivityReminder',
          lead,
          {
            days_since_signup: dayMark,
            page_short_name: pageShortName,
            claim_url: claimUrl,
          },
          { last_no_raise_nudge_day: dayMark }
        );
      }

      if (newlyDueNudges.length > 0) {
        updates.L = [...noRaiseRemindersSent, ...newlyDueNudges].join(',');
      }
    }

    // ---- 4. Reminder-to-claim tracking (message itself lives in Klaviyo Flow) ----
    // We don't send the reminder email here — Klaviyo's Flow does that off the
    // ClaimLinkSent event + the page_claimed profile property. We just need to
    // make sure page_claimed is accurate on the profile, which step 1 already did.
    // If NOT claimed yet, refresh the profile property so the Flow's conditional
    // split sees the latest state whenever it evaluates.
    if (!stats.claimed) {
      await sendKlaviyoEvent(
        'FollowUpStatusCheck',
        lead,
        { hours_since_captured: Math.floor((Date.now() - new Date(dateCaptured)) / 3600000) },
        { page_claimed: false }
      ).catch((err) => console.error('Klaviyo status refresh failed:', err.message));
    }

    if (Object.keys(updates).length > 0) {
      await updateSheetRow(rowNumber, updates);
    }
  }

  console.log('Follow-up check complete.');
}

function startFollowUpJob() {
  const cron = require('node-cron');
  cron.schedule('0 */6 * * *', () => {
    runFollowUpCheck().catch((err) => console.error('FOLLOW-UP JOB ERROR:', err));
  });
  console.log('Follow-up job scheduled (every 6 hours).');
}

module.exports = startFollowUpJob;