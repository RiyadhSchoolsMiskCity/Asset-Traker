const express=require('express');
const Database=require('better-sqlite3');
const cors=require('cors');
const path=require('path');
const nodemailer=require('nodemailer');
const crypto=require('crypto');

const app=express();
const PORT=3000;
app.use(cors());
app.use(express.json({limit:'10mb'}));
app.use(express.static(path.join(__dirname,'public')));

const db=new Database(path.join(__dirname,'inventory.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS supply (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sn TEXT UNIQUE NOT NULL,model TEXT,purchase_date TEXT,
    po TEXT,partner TEXT,status TEXT DEFAULT 'Stock New',note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sn TEXT NOT NULL,model TEXT,name TEXT,email TEXT,
    location TEXT,date TEXT,delivered_by TEXT,
    refund_date TEXT,refund_by TEXT,note TEXT,
    signature TEXT,signed_at TEXT,sign_token TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ══ عدّل هذه البيانات ══
const EMAIL_USER='your-email@rsmc.edu.sa';  // ← إيميلك
const EMAIL_PASS='your-password';            // ← كلمة المرور
const EMAIL_HOST='smtp.office365.com';       // Microsoft 365
const EMAIL_PORT=587;
const SERVER_URL='http://localhost:3000';    // ← IP جهازك لو شبكة داخلية

const transporter=nodemailer.createTransport({
  host:EMAIL_HOST,port:EMAIL_PORT,secure:false,
  auth:{user:EMAIL_USER,pass:EMAIL_PASS}
});

// SUPPLY
app.get('/api/supply',(req,res)=>res.json(db.prepare('SELECT * FROM supply ORDER BY created_at DESC').all()));
app.post('/api/supply',(req,res)=>{
  const{sn,model,purchase_date,po,partner,status,note}=req.body;
  try{db.prepare(`INSERT INTO supply(sn,model,purchase_date,po,partner,status,note)VALUES(?,?,?,?,?,?,?)ON CONFLICT(sn)DO UPDATE SET model=excluded.model,status=excluded.status,note=excluded.note`).run(sn,model,purchase_date,po,partner,status||'Stock New',note);res.json({ok:true});}
  catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/supply/bulk',(req,res)=>{
  const s=db.prepare(`INSERT INTO supply(sn,model,purchase_date,po,partner,status,note)VALUES(?,?,?,?,?,?,?)ON CONFLICT(sn)DO UPDATE SET model=excluded.model,status=excluded.status`);
  db.transaction(items=>items.forEach(x=>s.run(x.sn,x.model,x.purchaseDate||'',x.po||'',x.partner||'',x.status||'Stock New',x.note||'')))(req.body.items);
  res.json({ok:true,count:req.body.items.length});
});
app.patch('/api/supply/:sn/status',(req,res)=>{db.prepare('UPDATE supply SET status=? WHERE sn=?').run(req.body.status,req.params.sn);res.json({ok:true});});
app.delete('/api/supply/:sn',(req,res)=>{db.prepare('DELETE FROM supply WHERE sn=?').run(req.params.sn);res.json({ok:true});});

// OPERATIONS
app.get('/api/operations',(req,res)=>res.json(db.prepare('SELECT * FROM operations ORDER BY created_at DESC').all()));
app.post('/api/operations',async(req,res)=>{
  const{sn,model,name,email,location,date,delivered_by,note}=req.body;
  const token=crypto.randomBytes(32).toString('hex');
  try{
    db.prepare(`INSERT INTO operations(sn,model,name,email,location,date,delivered_by,note,sign_token)VALUES(?,?,?,?,?,?,?,?,?)`).run(sn,model,name,email,location||'',date,delivered_by,note,token);
    db.prepare("UPDATE supply SET status='Under Usage' WHERE sn=?").run(sn);
    if(email)await sendSignEmail(email,name,sn,model,date,location||'',token);
    res.json({ok:true,token});
  }catch(e){res.status(400).json({error:e.message});}
});
app.patch('/api/operations/:id',(req,res)=>{
  const{name,email,location,date,delivered_by,refund_date,refund_by,note}=req.body;
  db.prepare(`UPDATE operations SET name=?,email=?,location=?,date=?,delivered_by=?,refund_date=?,refund_by=?,note=? WHERE id=?`).run(name,email,location||'',date,delivered_by,refund_date,refund_by,note,req.params.id);
  const op=db.prepare('SELECT sn FROM operations WHERE id=?').get(req.params.id);
  if(op)db.prepare('UPDATE supply SET status=? WHERE sn=?').run(refund_date?'Refund':'Under Usage',op.sn);
  res.json({ok:true});
});
app.delete('/api/operations/:id',(req,res)=>{db.prepare('DELETE FROM operations WHERE id=?').run(req.params.id);res.json({ok:true});});
app.post('/api/operations/:id/resend',async(req,res)=>{
  const op=db.prepare('SELECT * FROM operations WHERE id=?').get(req.params.id);
  if(!op||!op.email)return res.status(400).json({error:'لا يوجد إيميل'});
  await sendSignEmail(op.email,op.name,op.sn,op.model,op.date,op.location,op.sign_token);
  res.json({ok:true});
});

// SIGNATURE
app.get('/api/sign/:token',(req,res)=>{
  const op=db.prepare('SELECT * FROM operations WHERE sign_token=?').get(req.params.token);
  if(!op)return res.status(404).json({error:'رابط غير صالح'});
  if(op.signature)return res.status(400).json({error:'تم التوقيع مسبقاً',signed:true});
  res.json(op);
});
app.post('/api/sign/:token',async(req,res)=>{
  const op=db.prepare('SELECT * FROM operations WHERE sign_token=?').get(req.params.token);
  if(!op)return res.status(404).json({error:'رابط غير صالح'});
  if(op.signature)return res.status(400).json({error:'تم التوقيع مسبقاً'});
  db.prepare("UPDATE operations SET signature=?,signed_at=datetime('now') WHERE sign_token=?").run(req.body.signature,req.params.token);
  await sendConfirmEmail(op,req.body.signature);
  res.json({ok:true});
});

async function sendSignEmail(to,name,sn,model,date,location,token){
  const link=`${SERVER_URL}/sign.html?token=${token}`;
  try{await transporter.sendMail({
    from:`"نظام جرد الأصول" <${EMAIL_USER}>`,to,
    subject:`✍ عهدة استلام — ${model} (${sn})`,
    html:`<div dir="rtl" style="font-family:Arial;max-width:500px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)">
      <div style="background:linear-gradient(135deg,#0d2e2a,#1a9c78);padding:24px;text-align:center;color:#fff"><h2 style="margin:0">📋 عهدة استلام أصل</h2></div>
      <div style="padding:24px">
        <p>عزيزي <strong>${name}</strong>، تم تسليمك الأصل التالي:</p>
        <table style="width:100%;border-collapse:collapse;background:#f0fdf4;border-radius:8px;margin:14px 0">
          <tr><td style="padding:8px 12px;color:#6b9e90;font-size:13px">S/N</td><td style="padding:8px 12px;font-weight:bold">${sn}</td></tr>
          <tr style="border-top:1px solid #c8e6dc"><td style="padding:8px 12px;color:#6b9e90;font-size:13px">الموديل</td><td style="padding:8px 12px;font-weight:bold">${model}</td></tr>
          <tr style="border-top:1px solid #c8e6dc"><td style="padding:8px 12px;color:#6b9e90;font-size:13px">الموقع</td><td style="padding:8px 12px;font-weight:bold">${location||'—'}</td></tr>
          <tr style="border-top:1px solid #c8e6dc"><td style="padding:8px 12px;color:#6b9e90;font-size:13px">التاريخ</td><td style="padding:8px 12px;font-weight:bold">${date||'—'}</td></tr>
        </table>
        <a href="${link}" style="display:block;background:linear-gradient(135deg,#0d2e2a,#1a9c78);color:#fff;text-decoration:none;padding:14px;border-radius:8px;text-align:center;font-size:16px;font-weight:bold;margin:16px 0">✍ اضغط هنا للتوقيع</a>
        <p style="color:#999;font-size:11px;text-align:center">الرابط صالح مرة واحدة فقط</p>
      </div>
      <div style="text-align:center;color:#999;font-size:11px;padding:14px;border-top:1px solid #eee">Riyadh Schools — IT Department</div>
    </div>`
  });console.log('Email sent:',to);}
  catch(e){console.error('Email error:',e.message);}
}

async function sendConfirmEmail(op,sig){
  try{await transporter.sendMail({
    from:`"نظام جرد الأصول" <${EMAIL_USER}>`,to:EMAIL_USER,
    subject:`✅ تم التوقيع — ${op.name} (${op.sn})`,
    html:`<div dir="rtl" style="font-family:Arial;max-width:500px;margin:auto;padding:24px;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.1)">
      <h2 style="color:#0d2e2a">✅ تم التوقيع على العهدة</h2>
      <p><strong>${op.name}</strong> — ${op.sn} (${op.model})</p>
      <p>الموقع: ${op.location||'—'} | ${new Date().toLocaleString('ar-SA')}</p>
      <div style="border:2px solid #1a9c78;border-radius:8px;padding:10px;margin:14px 0;text-align:center;background:#f0fdf4">
        <img src="${sig}" style="max-width:100%;max-height:120px"/>
      </div>
    </div>`
  });}catch(e){console.error('Confirm error:',e.message);}
}

app.listen(PORT,()=>{
  console.log(`\n✅ السيرفر يعمل: http://localhost:${PORT}`);
  console.log(`📦 قاعدة البيانات: inventory.db`);
  console.log(`\n⚠  عدّل EMAIL_USER و EMAIL_PASS و SERVER_URL في server.js`);
});
