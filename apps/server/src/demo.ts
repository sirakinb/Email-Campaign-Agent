import { env } from './env.js';
import { sql, json } from './db.js';

export const DEMO_MARKER = 'penny-fictional-demo-v1';
export const DEMO_HOMES = [
  { id: 'demo-maple', address: '14 Maple Walk', neighborhood: 'Garden Quarter', rent: 1650, beds: 2, baths: 1, sqft: 980, color: '#b5a2df', description: 'Fictional two-bedroom home with a private patio, in-unit laundry and generous natural light. Available now.' },
  { id: 'demo-harbor', address: '28 Harbor Lane', neighborhood: 'Harbor District', rent: 1925, beds: 3, baths: 2, sqft: 1280, color: '#9ebeb5', description: 'Fictional three-bedroom home with a covered porch, two bathrooms and off-street parking. Available now.' },
  { id: 'demo-cedar', address: '6 Cedar Court', neighborhood: 'Cedar Square', rent: 1375, beds: 1, baths: 1, sqft: 720, color: '#d7b99a', description: 'Fictional one-bedroom apartment with an open kitchen, generous closet space and a shared courtyard. Available now.' },
];

export function assertDemoConfiguration(values: Record<string, string | undefined> = process.env) {
  if (values.DEMO_MODE !== 'true') return;
  const forbidden = Object.keys(values).filter((key) => /^(ZOHO_|PHOTON_|AGENTMAIL_|COMPOSIO_|CLOUDINARY_|FAL_|ANTHROPIC_API_KEY$)/.test(key) && values[key]);
  if (forbidden.length) throw new Error(`Demo refuses live integration credentials: ${forbidden.join(', ')}`);
  if (!values.DEMO_INSTANCE_ID) throw new Error('Demo requires its own DEMO_INSTANCE_ID.');
}

/** Refuses an existing non-demo database; never copies or scrubs client records. */
export async function initializeDemo(reset = false) {
  if (!env.demoMode) throw new Error('Demo setup is unavailable in the live workspace.');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(73821945)`;
    const [marker] = await tx<{ value: { kind: string; instance: string } }[]>`select value from settings where key = 'demo_workspace'`;
    if (marker && (marker.value.kind !== DEMO_MARKER || marker.value.instance !== process.env.DEMO_INSTANCE_ID)) throw new Error('Demo database identity does not match.');
    if (!marker) {
      const [count] = await tx<{ n: number }[]>`select ((select count(*) from threads) + (select count(*) from drafts) + (select count(*) from approvals) + (select count(*) from zoho_campaigns) + (select count(*) from zoho_lists) + (select count(*) from listings) + (select count(*) from memories) + (select count(*) from connected_apps) + (select count(*) from connections where secrets <> '{}'))::int as n`;
      if (count?.n) throw new Error('Refusing to seed a database containing existing workspace data.');
    }
    if (marker && !reset) return;
    const [busy] = await tx<{ n: number }[]>`select count(*)::int as n from agent_jobs where status in ('queued','running')`;
    if (busy?.n) throw new Error('Wait for Penny to finish or stop the current job before resetting.');
    await tx`delete from approvals`;
    await tx`delete from drafts`;
    await tx`delete from memories`;
    await tx`delete from threads`;
    await tx`delete from zoho_campaigns`;
    await tx`delete from zoho_lists`;
    await tx`delete from listings`;
    await tx`delete from sync_runs`;
    await tx`delete from connected_apps`;
    await tx`delete from inbound_seen`;
    await tx`update connections set secrets = '{}', status = 'not_connected', detail = 'Unavailable in the fictional demo workspace.'`;
    await tx`update automations set enabled = false, last_run_at = null, last_status = null`;
    await tx`update guardrails set level = 'approve_first' where action in ('send_test','upload_draft','list_hygiene','save_memory','generate_media','connected_app_action')`;
    const settings = {
      demo_workspace: { kind: DEMO_MARKER, instance: process.env.DEMO_INSTANCE_ID },
      agent: { name: 'Penny', enabled: true },
      brand: { name: 'Example company', product: 'Penny demo', accent: '#a855f7' },
      defaults: { sender_email: 'hello@willowfinch.example', sender_name: 'Willow & Finch Rentals', list_id: 'demo-prospects', list_name: 'Demo prospects', topic_id: 'demo-homes', topic_name: 'Available homes', listings_url: `${env.publicUrl}/demo/properties` },
    };
    for (const [key, value] of Object.entries(settings)) await tx`insert into settings (key,value) values (${key},${json(value)}) on conflict (key) do update set value = excluded.value`;
    await tx`insert into zoho_lists (id,name,active,bounced,unsubscribed) values ('demo-prospects','Demo prospects',5000,0,0)`;
    for (const home of DEMO_HOMES) await tx`insert into listings (id,url,address,city,neighborhood,rent,rent_text,beds,baths,sqft,available,title,description,pets,photo_url)
      values (${home.id},${`${env.publicUrl}/demo/properties/${home.id}`},${home.address},'Cedar Bay (fictional)',${home.neighborhood},${home.rent},${`$${home.rent.toLocaleString('en-US')}/month`},${home.beds},${home.baths},${home.sqft},'Now',${home.address},${home.description},'Ask about the fictional pet policy',${`${env.publicUrl}/demo-assets/${home.id}.svg`})`;
    const subjects = ['A fresh look at Cedar Bay','Space for your next chapter','Three homes available this month','Find your next place','A new season, a new address','Explore this week’s homes','Patio, parking or a courtyard?','Three homes from $1,375 · Available now'];
    const clicks = [55,60,65,50,70,60,75,115];
    for (let i=0; i<subjects.length; i++) {
      const id=`demo-campaign-${i+1}`;
      const date=new Date(Date.now()-(2+(7-i)*7)*86_400_000).toISOString().slice(0,10);
      await tx`insert into zoho_campaigns (id,name,status,type,subject,sender_email,sender_name,list_ids,list_names,topic_id,topic_name,send_date,created_at,series,email_number,theme)
        values (${id},${`${date} Cedar Bay Email ${i+1}`},'sent','normal',${subjects[i]!},'hello@willowfinch.example','Willow & Finch Rentals',${json(['demo-prospects'])},${json(['Demo prospects'])},'demo-homes','Available homes',${date},${`${date}T15:00:00Z`},'Cedar Bay homes',${i+1},${i===7?'Concrete home features':'Available homes'})`;
      await tx`insert into zoho_reports (campaign_id,sent,opens,opens_reliable,opens_mpp,clicks,hard_bounced,optout,detailed)
        values (${id},5000,${1100+i*30},${850+i*20},${250+i*10},${clicks[i]!},${i===7?3:5},2,true)`;
      for (let h=0;h<3;h++) await tx`insert into zoho_links (campaign_id,link_id,url,unique_clicks) values (${id},${`home-${h}`},${`${env.publicUrl}/demo/properties/${DEMO_HOMES[h]!.id}`},${Math.floor(clicks[i]!*[0.5,0.3,0.2][h]!)})`;
    }
    await tx`insert into memories (title,body) values ('Demo workspace','Every property, campaign and result here is invented. Discuss the sample data as fictional. External actions are simulated; never claim an email was actually delivered or a real Zoho account was changed.')`;
    await tx`insert into sync_runs (source,status,detail,rows,finished_at) values ('appfolio','ok','Fictional demo fixtures; no external sync.',3,now()),('zoho_campaigns','ok','Eight fictional campaign results.',8,now())`;
  });
}

export function demoHomeSvg(id: string): string | null {
  const home = DEMO_HOMES.find((h) => h.id === id);
  if (!home) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#ece8e1"/><circle cx="780" cy="110" r="55" fill="#fff8e2"/><path d="M0 420 Q280 340 510 415 T960 400 V540 H0Z" fill="#a7b4a1"/><rect x="280" y="205" width="390" height="235" fill="${home.color}"/><path d="M235 215 L475 65 L715 215Z" fill="#393342"/><rect x="438" y="310" width="75" height="130" fill="#544657"/><g fill="#f7f2d9" stroke="#63556a" stroke-width="8"><path d="M318 260h70v80h-70z"/><path d="M560 260h70v80h-70z"/></g><path d="M438 440L380 540h195L513 440" fill="#d9cbb8"/><text x="40" y="485" font-family="sans-serif" font-size="25" fill="#27232d">${home.address}</text><text x="40" y="520" font-family="sans-serif" font-size="17" fill="#48414c">Illustration · Fictional demo property</text></svg>`;
}
