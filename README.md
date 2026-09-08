# Colite BOM Intelligence cloud gateway

This small Node service keeps the OpenAI API key out of the Windows application. It accepts only selected, rendered planset pages and returns structured extraction results or a structured procurement rule.

Version 0.4.3 restricts Critical EBoS extraction to the approved planset BOM categories `OCPD`, `DISCONNECT`, `MLO PANEL BOARD`, and `DC COMBINER BOX`. Notes are excluded, genuine `WIRING` rows are returned as non-critical Installer stock, and `7 JAW` is returned as Monitoring.

## Required environment variables

- `OPENAI_API_KEY`: company-owned OpenAI API key. Never add it to source control or the desktop installer.
- `COLITE_GATEWAY_TOKEN`: a long random access token shared with approved desktop installations.
- `PORT`: supplied by most hosting providers; defaults to `8787` locally.

Optional:

- `COLITE_AI_MODEL`: defaults to `gpt-5.6-luna`.
- `COLITE_UPDATE_MANIFEST_PATH`: absolute path to the published Windows `latest.json` file.
- `COLITE_INPUT_COST_PER_MILLION` and `COLITE_OUTPUT_COST_PER_MILLION`: pricing values used only for the in-app estimate.

## Start

```powershell
$env:OPENAI_API_KEY="your-key-in-the-host-secret-store"
$env:COLITE_GATEWAY_TOKEN="a-long-random-token"
npm start
```

Do not run this on an employee computer as the production gateway. Deploy it to a company-approved HTTPS host that supports requests up to 45 MB and set the secrets in that host's encrypted environment-variable controls.
