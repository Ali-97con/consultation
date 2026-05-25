'use strict';
// تشغيل: node migrate.js
// يقرأ crm-data.json ويرفعه إلى MongoDB

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ ضع MONGODB_URI في البيئة أولاً');
  console.error('   مثال: $env:MONGODB_URI="mongodb+srv://..." ; node migrate.js');
  process.exit(1);
}

const StoreSchema = new mongoose.Schema({
  clients:      [mongoose.Schema.Types.Mixed],
  closers:      [String],
  setters:      [String],
  custom_plans: [mongoose.Schema.Types.Mixed],
  team_trash:   [mongoose.Schema.Types.Mixed],
  _nextId:      { type: Number, default: 1000 },
});
const Store = mongoose.model('Store', StoreSchema);

async function run() {
  const filePath = path.join(__dirname, 'crm-data.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  console.log(`📂 قراءة ${data.clients.length} عميل من crm-data.json`);

  await mongoose.connect(MONGODB_URI);
  console.log('✅ متصل بـ MongoDB');

  await Store.deleteMany({});
  await Store.create({
    clients:      data.clients      || [],
    closers:      data.closers      || [],
    setters:      data.setters      || [],
    custom_plans: data.custom_plans || [],
    team_trash:   data.team_trash   || [],
    _nextId:      data._nextId      || 1000,
  });

  console.log(`✅ تم رفع ${data.clients.length} عميل إلى MongoDB`);
  await mongoose.disconnect();
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
