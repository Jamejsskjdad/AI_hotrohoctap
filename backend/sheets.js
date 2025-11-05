const { google } = require("googleapis");

const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  undefined,
  (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets"]
);

async function appendLog(row) {
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "logs!A:Z",
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

module.exports = { appendLog };
