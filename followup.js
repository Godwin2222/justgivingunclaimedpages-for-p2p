const cron = require('node-cron');
 
cron.schedule('0 */6 * * *', async () => {
  console.log('Running follow-up check...');
 
  const sheetData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Tracker!A:J',
  });
 
  const rows = sheetData.data.values.slice(1); // skip header row
 
  for (let i = 0; i < rows.length; i++) {
    const [
      name, email, phone, dateCaptured, claimUrl,
      sentStatus, claimed, dateClaimed, amount, pageShortName
    ] = rows[i];
 
    if (claimed === 'Yes') continue;
 
    const pageStatus = await axios.get(
      `${JG_API_BASE}/v1/fundraising/pages/${pageShortName}`
    );
 
    const hoursSinceSent =
      (Date.now() - new Date(dateCaptured)) / (1000 * 60 * 60);
 
    if (pageStatus.data.status === 'Claimed') {
      await updateSheetRow(i + 2, {
        claimed: 'Yes',
        dateClaimed: new Date().toISOString(),
      });
      await fireMetaEvent('PageClaimed', { email, phone }, { page: pageShortName });
      continue;
    }
 
    if (hoursSinceSent >= 48 && hoursSinceSent < 54 && sentStatus !== 'Reminder1Sent') {
      await sendReminderEmail(name, email, claimUrl, 1);
      await updateSheetRow(i + 2, { sentStatus: 'Reminder1Sent' });
    }
 
    if (hoursSinceSent >= 72 && hoursSinceSent < 78 && sentStatus !== 'Reminder2Sent') {
      await sendReminderEmail(name, email, claimUrl, 2);
      await updateSheetRow(i + 2, { sentStatus: 'Reminder2Sent' });
    }
  }
});
 
async function sendReminderEmail(name, email, claimUrl, reminderNumber) {
  const subjects = {
    1: "Don't forget — your fundraising page is waiting",
    2: 'Last reminder: claim your Hike for Change page',
  };
  await transporter.sendMail({
    from: '"Path to Possibilities" <hello@pathtopossibilities.org>',
    to: email,
    subject: subjects[reminderNumber],
    html: `<p>Hi ${name.split(' ')[0]}, just a reminder your ` +
      `fundraising page is ready and waiting: ` +
      `<a href="${claimUrl}">Claim it here</a></p>`,
  });
}
