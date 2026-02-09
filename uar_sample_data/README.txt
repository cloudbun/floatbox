UAR Sample Data
===============

Test files for the User Access Review tool. Drop these CSVs into the app
to exercise the full pipeline.

Files
-----
1. hr_source_of_truth.csv  (SoT)  — 50 employees from the HR system
2. okta_export.csv         (Sat)  — 51 Okta accounts (SSO/IdP)
3. aws_iam_export.csv      (Sat)  — 31 AWS IAM users
4. sap_export.csv          (Sat)  — 22 SAP accounts (Finance/HR module)

Usage
-----
1. Drop hr_source_of_truth.csv first and mark it as Source of Truth.
2. Drop the three satellite files (okta, aws, sap).
3. Map columns when prompted (most should auto-detect).
4. Run the review and inspect the master report.

Built-In Scenarios
------------------
CRITICAL — Terminated employees with active accounts:
  - Rene Fontaine (E1042)  — terminated in SoT, still ACTIVE in Okta/AWS/SAP
  - Samuel Osei (E1043)    — terminated in SoT, still ACTIVE in Okta/AWS/SAP

Orphan accounts (satellite records with no SoT match):
  Okta:  jdoe@external.com, monitoring@acme.com, admin@oldcorp.com
  AWS:   deploy@internal.acme.com, terraform@internal.acme.com
  SAP:   E9901 (ktanaka@acme.com), E9902 (dmorrison@contractor.com)

Leave of absence — active satellite accounts:
  - Xenia Alexandrou (E1048) — on leave in SoT, active in SAP

Contractor with system access:
  - Zoe Mitchell (E1050) — contractor in SoT, active in SAP

Fuzzy match candidates:
  - Thomas Muller (E1019) vs Lena Muller (E1037) — same surname, different people
  - Yuki Tanaka (E1024) vs Kenji Tanaka (SAP orphan E9901) — surname collision

Column mapping variety:
  - SoT uses:  employee_id, full_name, email_address, employment_status
  - Okta uses: login, email, displayName, status, group, lastLogin
  - AWS uses:  UserName, user_principal_name, Role, AccessLevel, last_sign_in, Enabled
  - SAP uses:  PersonnelNumber, Name ("Last, First"), Email, Role, Status, LastLogon
