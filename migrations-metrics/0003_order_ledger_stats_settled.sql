-- Count only settled commerce on /stats, and publish the rest separately.
--
-- order_ledger_stats used to hold every recorded order. Before 2026-11-07
-- (rozo-mpprouter #296) an x402 call whose Stellar settlement failed still
-- wrote an order row, so /stats counted it as a paid call and as volume
-- although the buyer was never charged. #296 stopped writing those rows;
-- this column lets them be written again as unsettled instead of dropped.
--
-- Add-only: a new column with a default. Existing writers that do not name
-- the column keep working and get settled = 1.
ALTER TABLE order_ledger_stats ADD COLUMN settled INTEGER NOT NULL DEFAULT 1;

-- Backfill: the orders the public ledger reports without any settlement
-- (settlement_status not_recorded, failed or unknown) as of 2026-11-07.
-- Order ids are public (GET /v1/ledger). Ids not present in this table are a
-- no-op.
UPDATE order_ledger_stats SET settled = 0 WHERE order_id IN ('ord_mtrwmbbx_w453zq1c','ord_mu41upib_o19r3qx5','ord_mu7dw0uj_11syoo4x','ord_muixoj04_ap54dqvt','ord_mumv6i4y_vn1wei70','ord_muqwwdxz_zy02bepe','ord_mure2j76_i7mg676t','ord_murv640a_lfxsv54a','ord_mv5bk6ro_0gnaeukp','ord_mviwanje_br2zw4ob','ord_mvq1gybo_sumxirku','ord_mvql2lw9_ffa7n4jc','ord_mvqr8561_2fdepnel','ord_mvss1s78_wr0et7u2','ord_mvtdih09_l8dxcsy1','ord_mvtvi5bg_f9i3vvij','ord_mvubs3p3_90031yo4','ord_mvukcyg0_0gmuqkso','ord_mvvzsk7j_3xhskgkb','ord_mvw8dn0m_a378bz8y','ord_mw2fag32_csyihytm','ord_mw2nv868_0vi67a09','ord_mw53sei4_dza59oen','ord_mw53sj1j_vtk7s333','ord_mw55ojfs_e22gny1k','ord_mw569pw0_yzwaickc','ord_mw56oi5n_a3inekam','ord_mw56ot2u_i85867ic','ord_mw57j8vy_m8ukbpif','ord_mw621f6h_hmyn2l7v');
