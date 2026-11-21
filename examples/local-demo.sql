-- Local fixture only. The setup script executes this with --local, never remote.
-- Re-running preserves dashboard changes and never duplicates sample records.
INSERT INTO affiliates (email,name,code,status,commission_pct,source,created_at)
VALUES ('demo@example.test','Demo Affiliate','local-demo','active',20,'local-demo',unixepoch()*1000)
ON CONFLICT(email) DO NOTHING;

INSERT INTO affiliates (email,name,code,status,commission_pct,source,message,applied_at,created_at)
VALUES ('applicant@example.test','Demo Applicant','local-applicant','pending',20,'local-demo',
        'I share tutorials and would like to join the program.',unixepoch()*1000,unixepoch()*1000)
ON CONFLICT(email) DO NOTHING;

INSERT INTO clicks (affiliate_id,ip_hash,created_at)
SELECT id,'local-demo-click-1',unixepoch()*1000-86400000 FROM affiliates
WHERE email='demo@example.test' AND source='local-demo'
AND NOT EXISTS (SELECT 1 FROM clicks WHERE ip_hash='local-demo-click-1' AND affiliate_id=affiliates.id);
INSERT INTO clicks (affiliate_id,ip_hash,created_at)
SELECT id,'local-demo-click-2',unixepoch()*1000-7200000 FROM affiliates
WHERE email='demo@example.test' AND source='local-demo'
AND NOT EXISTS (SELECT 1 FROM clicks WHERE ip_hash='local-demo-click-2' AND affiliate_id=affiliates.id);
INSERT INTO clicks (affiliate_id,ip_hash,created_at)
SELECT id,'local-demo-click-3',unixepoch()*1000-3600000 FROM affiliates
WHERE email='demo@example.test' AND source='local-demo'
AND NOT EXISTS (SELECT 1 FROM clicks WHERE ip_hash='local-demo-click-3' AND affiliate_id=affiliates.id);

INSERT INTO conversions (affiliate_id,stripe_session_id,customer_email,amount_cents,commission_cents,status,created_at)
SELECT id,'cs_local_demo_pending','buyer1@example.test',4900,980,'pending',unixepoch()*1000-3600000
FROM affiliates WHERE email='demo@example.test' AND source='local-demo'
ON CONFLICT(stripe_session_id) DO NOTHING;
INSERT INTO conversions (affiliate_id,stripe_session_id,customer_email,amount_cents,commission_cents,status,created_at)
SELECT id,'cs_local_demo_approved','buyer2@example.test',7500,1500,'approved',unixepoch()*1000-86400000
FROM affiliates WHERE email='demo@example.test' AND source='local-demo'
ON CONFLICT(stripe_session_id) DO NOTHING;
INSERT INTO conversions (affiliate_id,stripe_session_id,customer_email,amount_cents,commission_cents,status,created_at,paid_at)
SELECT id,'cs_local_demo_paid','buyer3@example.test',9000,1800,'paid',unixepoch()*1000-604800000,unixepoch()*1000-86400000
FROM affiliates WHERE email='demo@example.test' AND source='local-demo'
ON CONFLICT(stripe_session_id) DO NOTHING;

INSERT INTO payouts (affiliate_id,amount_cents,status,created_at)
SELECT a.id,1800,'manual',c.paid_at FROM affiliates a JOIN conversions c ON c.affiliate_id=a.id
WHERE a.email='demo@example.test' AND a.source='local-demo' AND c.stripe_session_id='cs_local_demo_paid'
AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.affiliate_id=a.id AND p.created_at=c.paid_at AND p.status='manual');

-- Enrich only the known fixture orders; retain edits to their financial status.
UPDATE conversions SET currency='usd', commission_pct=20,
    customer_country=CASE stripe_session_id WHEN 'cs_local_demo_pending' THEN 'US'
        WHEN 'cs_local_demo_approved' THEN 'SG' ELSE 'DE' END,
    items_json=json_array(json_object('product_id',
        CASE stripe_session_id WHEN 'cs_local_demo_pending' THEN 'prod_demo_animation'
            WHEN 'cs_local_demo_approved' THEN 'prod_demo_capture' ELSE 'prod_demo_expression' END,
        'name', CASE stripe_session_id WHEN 'cs_local_demo_pending' THEN 'Animation Toolkit'
            WHEN 'cs_local_demo_approved' THEN 'Face Capture Plugin' ELSE 'Expression Pack' END,
        'variant','Standard','quantity',1)),
    approved_at=CASE WHEN status IN ('approved','paid') THEN COALESCE(approved_at,created_at) ELSE approved_at END,
    payout_id=CASE WHEN stripe_session_id='cs_local_demo_paid' THEN
        (SELECT p.id FROM payouts p WHERE p.affiliate_id=conversions.affiliate_id AND p.status='manual'
            AND p.created_at=conversions.paid_at LIMIT 1) ELSE payout_id END
WHERE stripe_session_id IN ('cs_local_demo_pending','cs_local_demo_approved','cs_local_demo_paid')
    AND affiliate_id IN (SELECT id FROM affiliates WHERE email='demo@example.test' AND source='local-demo');
UPDATE payouts SET paid_at=COALESCE(paid_at,(SELECT MAX(c.paid_at) FROM conversions c WHERE c.payout_id=payouts.id))
WHERE affiliate_id IN (SELECT id FROM affiliates WHERE email='demo@example.test' AND source='local-demo');
