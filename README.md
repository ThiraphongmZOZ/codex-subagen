# Acode Agent Dashboard

เว็บ dashboard ภาษาไทยสำหรับ Codex coordinator และ subagent บนเครื่องนี้

## เปิดแอป

ต้องมี Node.js 20+ และ Codex CLI ใน PATH

```powershell
cd C:\.Acode
npm start
```

เปิด http://127.0.0.1:4310 หากยังไม่ได้เข้าสู่ระบบ ให้ใช้ `codex login` ใน terminal ของคุณ จากนั้นกดเชื่อมต่อใหม่ในหน้าเว็บ แอปใช้ Codex App Server และการเข้าสู่ระบบ Codex ไม่ต้องใส่ API key ในหน้าเว็บ

## ใช้งาน

1. เปิด Configuration เลือกโฟลเดอร์ทำงาน โมเดล เพดาน subagent และคำสั่งของแต่ละบทบาท
2. ใส่งานและกดเริ่มทำงาน หากต้องการแบ่งงานแน่นอน ให้ระบุใน prompt เช่น “ใช้ subagent สองตัว ตัวแรกตรวจโครงสร้าง ตัวที่สองตรวจข้อผิดพลาด แล้วรวบรวมผล”
3. เลือกงานเก่าจากรายการด้านบนแล้วใช้ “สั่งต่อ thread นี้” เพื่อคุยต่อในบริบทเดิม หรือใช้ “เริ่มงานใหม่” เพื่อเปิดบทสนทนาใหม่
4. ดูสถานะและผลลัพธ์จริงใน Agent workspace
5. ตอบคำขออนุมัติคำสั่งหรือการแก้ไฟล์ผ่านหน้าเว็บเมื่อ Codex ร้องขอ
6. หยุดงานด้วยปุ่มหยุด แอปจะส่ง interrupt ให้ coordinator และลูกที่กำลังทำงาน

## ขอบเขตเวอร์ชันนี้

- ติดตามเฉพาะงานที่เริ่มจาก dashboard นี้ ไม่ใช่ทุกแชตของ Codex desktop
- รองรับหนึ่งงานหลักที่กำลังทำงานต่อหนึ่ง instance มี subagent ได้ตามเพดานที่ตั้ง
- Dashboard สร้าง custom agent ตามบทบาทที่เปิดใช้งานใน `<workspace>/.codex/agents/`; แต่ละ role เลือกโมเดล effort และ sandbox ได้ การแบ่งงานจริงยังขึ้นกับ Coordinator
- รายละเอียดงานลูกมาจาก prompt ที่ protocol ส่งให้ หรือบรรทัด “งาน:” ที่ agent รายงานเอง หากไม่มีข้อมูลจะแสดงว่ารายละเอียดยังไม่ถูกส่งมา
- ประวัติงาน การตั้งค่า และเหตุการณ์ล่าสุด 250 รายการบันทึกใน `data/` ผลลัพธ์ที่สตรีมถูกจำกัดขนาด
- หลัง restart งานเก่าที่เคย active แสดง “ไม่ทราบสถานะ” ไม่อ้างว่างานยังทำอยู่ และไม่ resume อัตโนมัติ
- ค่าเริ่มต้นของงานใหม่คือ workspace-write และ on-request approvals ผู้ใช้ปรับ approval mode และ sandbox ได้ใน Configuration การอนุมัติผ่าน UI รองรับ command execution กับ file changes คำขอ interactive ชนิดอื่นจะถูกปฏิเสธพร้อมบันทึกกิจกรรม
- ไม่แสดงความคิดภายในของโมเดล แสดงเฉพาะกิจกรรมเครื่องมือ แผนที่รายงาน และคำตอบ
- App Server เป็น integration ที่มีส่วน experimental ต้องตรวจใหม่เมื่ออัปเดต Codex
- Server ผูกกับ 127.0.0.1 ตรวจ Host/Origin และ token ของคำขอแก้ไข ไม่ควรเปิดผ่าน proxy สาธารณะโดยไม่มี authentication เพิ่มเติม

```powershell
npm install
npx playwright install chromium
npm test
```

`npm test` runs reducer and config recovery checks plus a Playwright smoke test for Workflow and Config. Screenshots are saved under ignored `work/`.

เอกสารอ้างอิง: https://learn.chatgpt.com/docs/app-server และ https://learn.chatgpt.com/docs/agent-configuration/subagents

รายการโมเดลโหลดจาก Codex CLI ทุกหน้า รวมโมเดลที่ซ่อน และรีเฟรชได้ใน Configuration รุ่น GPT-6.1-Sol, GPT-6-Sol และ GPT-6-Luna ที่ไม่มีใน catalog จะแสดงในกลุ่มเพิ่มเติมที่ยังไม่ยืนยันสิทธิ์ การเลือกหรือบันทึกไม่ได้รับประกันว่า runtime/บัญชีจะใช้งานได้ ข้อผิดพลาดจริงแสดงเมื่อเริ่มงาน การเปลี่ยนโมเดลมีผลกับงานใหม่ ส่วนสั่งต่อใช้โมเดลของ thread เดิม

หน้า Workflow (/#workflow) แสดงต้นไม้ coordinator/subagent ของงานที่เลือก คลิกกล่องเพื่อดูโมเดลของ thread งาน กิจกรรม และผลลัพธ์ มีซูม/พอดีจอ/หยุดงาน สถานะสดผ่าน SSE กล่องและเส้นเคลื่อนไหวเฉพาะสถานะทำงาน รองรับ prefers-reduced-motion หาก Codex ไม่ส่งโมเดลจะแสดงว่ายังไม่ทราบโมเดล


Configuration มี Reasoning level ตาม supportedReasoningEfforts ของโมเดล ใช้ค่าเริ่มต้นของโมเดลหากไม่ได้เลือกระดับ การตั้งค่ามีผลกับงานใหม่ ส่ง model_reasoning_effort ให้ตัวหลักและ agents.default_subagent_reasoning_effort เป็นค่าเริ่มต้นของตัวลูก การสั่งต่อใช้การตั้งค่าของ thread เดิม ตรวจการบันทึกและ validation ได้ด้วย node work/reasoning-check.mjs ขณะเปิด server


เพิ่มหน้า Chat history ที่ซิงก์ทุก thread จาก Codex CLI และ VS Code (`thread/list` sourceKinds cli/vscode) ทั้ง active และ archived เมื่อเริ่มแอป ปุ่ม “ซิงก์ประวัติทั้งหมด” อ่านทุกหน้าใหม่ และงานล่าสุดอัปเดตทุก 30 วินาที ค้นหาชื่อ/preview/workspace อ่านข้อความ thread ผ่าน `thread/read` (ไม่แสดง reasoning ภายใน) และเลือกสั่งต่อใน monitor โดยใช้ thread ID เดิม

Codex ใช้ writer lock แบบหนึ่ง process ต่อหนึ่ง thread หาก thread ยังเปิดเขียนอยู่ใน VS Code จะสั่งต่อใน thread เดิมจาก Dashboard ไม่ได้ ปิด thread ต้นทางเพื่อปล่อย lock หรือใช้ “แยก branch แล้วสั่งต่อ” เพื่อสร้าง thread ใหม่จากประวัติและทำงานต่อโดยไม่แตะต้นฉบับ

### ตั้งค่าทีม agent

หน้า Configuration ตั้งค่า Coordinator model/reasoning, เพดาน subagent, approval mode, sandbox, กติกาการประสานงาน และแต่ละ role แยก model, reasoning, คำอธิบาย, instructions, สถานะเปิดใช้ และ sandbox ได้ ค่าเริ่มต้นตาม workflow คือ Coordinator/Explorer/Worker/Luna, Planner/Sol, Reviewer/Luna และ Senior Reviewer/Sol สำหรับงานเสี่ยง โดย effort ของแต่ละ role ปรับได้ตาม model ที่เลือก

เมื่อบันทึก Dashboard จะเขียน custom agent TOML ที่จัดการเองไว้ใน `<workspace>/.codex/agents/acode-<role>.toml` เพื่อให้ Codex ใช้ model, effort และ sandbox ต่อ role จริง ไฟล์ที่ไม่ได้สร้างโดย Dashboard จะไม่ถูกเขียนทับ การปิดหรือลบบทบาทจะลบเฉพาะไฟล์ที่มีเครื่องหมายว่า Dashboard จัดการ ค่ามีผลกับงานใหม่
