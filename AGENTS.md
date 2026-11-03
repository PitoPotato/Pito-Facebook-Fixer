# Testing constraints for this project

- Never use the user's main Facebook account or existing personal-browser Facebook tabs as a test environment. Do not inspect, copy or reuse personal browser profiles, sessions, cookies, tokens, messages or storage for tests.
- Automated browser tests must create their own profile directories below this project's `test-results/`. Synthetic tests must intercept Facebook HTTP requests and label their results as synthetic.
- Live Facebook QA is allowed only in a separate Chromium profile created for this task, after the user confirms they personally logged in with a separate test account. Do not automate login, password, OTP or CAPTCHA entry.
- Test messages may only target the confirmed test account's self conversation. Do not send to the main account, real contacts or groups. Testing other recipients requires the user to identify and authorize that test recipient.
- Do not equate passing fixtures with passing production Facebook QA. Record production checks separately; leave unsupported or unverified features clearly labeled.
- Verify the complete capture -> background authorization -> IndexedDB commit -> unsend lookup -> native bubble text replacement path. The user requested native Facebook styling without an extra card or visible extension badge; provenance belongs in the tooltip/accessibility description. An observation counter alone is not proof of a successful write.
- Keep archive size/retention/queue limits and account separation checks. Sender authorization must continue to reject foreign sites and other extensions. Do not fix source errors by disabling authorization.

The user's current request requires repeated verification in isolated profiles. See `QA.md` and `npm run verify`.
