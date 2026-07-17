const Database = require('better-sqlite3');
const db = new Database('sceneai.db');
const row = db.prepare("SELECT first_message FROM characters WHERE name LIKE '%Adriana%'").get();
console.log("RAW:", JSON.stringify(row.first_message));
console.log("FIRST 200 chars:", row.first_message.substring(0, 200));
