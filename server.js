const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
require('dotenv').config();
 
const app = express();
app.use(express.json());
app.use(cors({
  origin: 'https://www.pathtopossibilities.co.uk', // your real Squarespace domain
  methods: ['POST'],
}));
 
// ---------------- CONFIG ----------------
// Use api.staging.justgiving.com while testing, api.justgiving.com once live
const JG_API_BASE = 'api.staging.justgiving.com';
const JG_APP_ID = process.env.JUSTGIVING_APP_ID;
const JG_CHARITY_ID = process.env.JUSTGIVING_CHARITY_ID;
const JG_EVENT_ID = process.env.JUSTGIVING_EVENT_ID; // optional
const JG_CAMPAIGN_GUID = process.env.JUSTGIVING_CAMPAIGN_GUID; // optional
const FUNDRAISING_TARGET = "500"; // suggested GBP target, adjust as needed
 
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_CONVERSIONS_API_TOKEN;
 
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
 
const transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY },
});
 
// ---------------- STEP 1: create the unclaimed JustGiving page ----------------
async function createUnclaimedPage(lead) {
  const story = "I'm taking part in Hike for Change to help send " +
    "out-of-school children in Nigeria back into education. Every " +
    "step and every pound raised gets a child closer to the classroom. " +
    "Please support me!";
 
  const payload = {
    email: lead.email,
    firstName: lead.firstName,
    lastName: lead.lastName,
    charityId: Number(JG_CHARITY_ID),
    eventId: JG_EVENT_ID ? Number(JG_EVENT_ID) : null, // omit/null if no registered event
    campaignGuid: JG_CAMPAIGN_GUID || null,
    pageShortName: `${lead.firstName}-${lead.lastName}-hike-${Date.now()}`
      .toLowerCase().replace(/\s+/g, '-'),
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
 
  // response.data includes: claimToken, pageGuid, signOnUrl, next.url (the claim link)
  return {
    claimUrl: response.data.next.url,
    pageShortName: payload.pageShortName,
    pageGuid: response.data.pageGuid,
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
  ];
 
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Tracker!A:J',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}
 
// ---------------- STEP 3: fire Meta Conversions API event ----------------
function hashSHA256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
 
async function fireMetaEvent(eventName, lead, extraData = {}) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`,
    {
      data: [{
        event_name: eventName, // 'Lead' | 'ClaimLinkSent' | 'PageClaimed'
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        user_data: {
          em: [hashSHA256(lead.email)],
          ph: lead.phone ? [hashSHA256(lead.phone)] : undefined,
        },
        custom_data: extraData,
      }],
      access_token: META_ACCESS_TOKEN,
    }
  );
}
 
// ---------------- STEP 4: send the claim email / WhatsApp ----------------
async function sendClaimEmail(lead, claimUrl) {
  await transporter.sendMail({
    from: '"Path to Possibilities" <hello@pathtopossibilities.org>',
    to: lead.email,
    subject: `${lead.firstName}, your Hike for Change fundraising page is ready`,
    html: `
      <p>Hi ${lead.firstName},</p>
      <p>Thank you for signing up for Hike for Change! Your fundraising
      page is ready — it just takes 60 seconds to claim it and make it
      yours.</p>
      <p><a href="${claimUrl}" style="background:#111;color:#fff;
      padding:12px 20px;text-decoration:none;border-radius:6px;">
      Claim Your Fundraising Page</a></p>
      <p>Once claimed, you can add your own photo, set your story, and
      start sharing with friends and family.</p>
      <p>See you on the trail,<br/>The Path to Possibilities Team</p>
    `,
  });
 
  if (lead.phone && process.env.TWILIO_SID) {
    const twilio = require('twilio')(
      process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN
    );
    await twilio.messages.create({
      from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
      to: 'whatsapp:' + lead.phone,
      body: `Hi ${lead.firstName}! Your Hike for Change fundraising page ` +
        `is ready. Claim it here: ${claimUrl}`,
    });
  }
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
  try {
    const lead = req.body; // { firstName, lastName, email, phone, consent }
 
    if (!lead.consent) {
      return res.status(400).json({ error: 'Consent required' });
    }
 
    const claimData = await createUnclaimedPage(lead);
    await logToSheet(lead, claimData);
    await fireMetaEvent('Lead', lead);
    await fireMetaEvent('ClaimLinkSent', lead, { page: claimData.pageShortName });
    await sendClaimEmail(lead, claimData.claimUrl);
 
    res.status(200).json({ success: true, claimUrl: claimData.claimUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});
 
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
