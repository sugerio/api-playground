# API Playground

A small web page for demoing the Suger API. It currently covers **GCP private offers**:

1. **Create a private offer**: build a new GCP private offer for a billing account and send it.
2. **Create an amendment offer**: start from an entitlement ID, fetch the live offer behind it,
   build a replacement offer from it, and send that.

Pick the environment at the top of the page:

| Environment | API host | Console (for tokens) |
|---|---|---|
| dev | `https://api.dev.suger.cloud` | <https://console.dev.suger.io> |
| prod | `https://api.suger.cloud` | <https://console.suger.io> |

The page logs each request and response at the bottom, so you can show the exact URL and JSON
body during a demo.

> **Prod creates real offers.** On prod, a red banner is shown and Create needs a second click
> ("Click again to create on PRODUCTION"). The sample IDs pre-filled on the page only exist on
> dev, so enter prod values before you use prod.

## Run it

Requires Node 18 or later. There is nothing to install.

```bash
node server.mjs
```

Open <http://localhost:8787>. To use another port, run `PORT=9000 node server.mjs`.

### Why there is a server

The API's CORS allowlist doesn't accept browser calls from this page. On dev it only accepts
`http://localhost:3000`, which is the web-react dev server's port, and a page opened straight
from disk is blocked too. `server.mjs` serves the page and forwards `/api/dev/*` to
`https://api.dev.suger.cloud` and `/api/prod/*` to `https://api.suger.cloud`. It reaches no
other host, passes your `Authorization` header through and stores nothing.

## Get a bearer token

1. Log in to the console for the environment you picked (see the table above).
2. Open the browser dev tools, go to the Network tab, and pick any request to that
   environment's API host.
3. Copy the `Authorization` request header. You can paste it with or without the `Bearer ` prefix.

Paste the token into **Connection → Bearer token** on the page. The page shows whose token it is
and how long it has left. Tokens last about an hour. A dev token doesn't work on prod or the
other way round, so the page keeps one token and one org ID per environment, only in this tab's
`sessionStorage`.

Set **Organization ID** to the org you want to work in. On dev the default is `pi0O8wuNs`
(Alvin Test 2), whose GCP integration creates offers through the GCP Commerce Producer API.
On prod there's no default.

## Case 1: create a private offer

| Step | What happens | API call |
|---|---|---|
| ① Load product | Reads the product's GCP plans | `GET /org/{orgId}/product/{productId}` |
| ② Build payload | Turns the form into an offer body. You can edit the JSON before sending it. | none |
| ③ Validate | Dry run: the backend runs every create-time check without creating anything | `POST /org/{orgId}/offer/validate` |
| ④ Create offer | Creates the offer, then checks its status until GCP publishes or rejects it | `POST /org/{orgId}/offer`, then `GET /org/{orgId}/offer/{id}` |

The dev defaults are product `Q7In3Ar2u` (Suger Cloud GTM Platform For Dev) and billing account
`0111B3-5FB955-6A700D`. This billing account is the test account the GCP offer E2E suite uses.

## Case 2: create an amendment offer

| Step | What happens | API call |
|---|---|---|
| ① Fetch | Entitlement, then the offer it came from, then the product | `GET /org/{orgId}/entitlement/{id}`, `GET /org/{orgId}/offer/{offerId}`, `GET /org/{orgId}/product/{productId}` |
| ② Build replacement | Copies the customer, billing account, plan, price model and sales contact from the live offer, applies your changes, and links the new offer to the original | none |
| ③ Validate | Dry run, as in case 1 | `POST /org/{orgId}/offer/validate` |
| ④ Create amendment | Creates the replacement offer and follows its status | `POST /org/{orgId}/offer` |

The dev default entitlement is `843I8Frci`. Its offer is a pay-as-you-go plan with a 3% usage discount.

These fields are what make the new offer a replacement of the original rather than a new deal:

```json
"metaInfo": {
  "isReplacementOffer": true,
  "replacedOfferResourceName": "projects/.../privateOffers/<original GCP offer id>",
  "replacedOfferEndTime": "<original term end>",
  "replacedOfferPaymentRecurrence": "MONTHLY_PERIOD"
}
```

Some rules the builder follows, each of them enforced by the backend or by GCP:

- **EULA type is required.** It defaults to the standard GCP EULA (`SCMP`), or keeps `CUSTOM`
  when the original offer had a custom EULA.
- **The amendment does not share the original's end date.** Through the GCP API, sharing the end
  date (`ALIGN_END_TIME`) becomes a fixed end date, and GCP rejects fixed end dates on monthly,
  quarterly or yearly billing. So the amendment runs for the duration you enter, counted from
  when the buyer accepts it.
- **Usage-discount-only offers** are sent with `MONTHLY_PERIOD` + `POSTPAY`, because that price
  model has no billing cadence of its own.
- **Expiry** is capped at the day before the original offer's next installment charge, when it
  has one. GCP rejects a replacement that is still open on that date.
- The builder only handles originals billed monthly, quarterly or yearly. Originals with custom
  installment schedules (`CUSTOM_PERIOD`) are refused with an error.

## After you press Create

The create call returns right away with status `DRAFT`. GCP publishes the offer a few seconds
later, so the page checks the offer for up to 3 minutes:

- `PENDING_ACCEPTANCE` means GCP published it. The page links the GCP offer and shows a
  **Cancel this offer** button, which needs two clicks.
- `CREATE_FAILED` or any other failure status shows GCP's error from `metaInfo.errorMessages`.

**Cancel offers you don't need.** An offer left open stays available to the test billing account
until it expires. Publishing doesn't email the buyer.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page: the form for each case, the steps, the status checks and the call log |
| `builders.js` | Builds the offer bodies. They follow the console's GCP amendment form (`apps/web-react/src/components/gcp/CreateReplacementOfferFormV2.tsx`) and the GCP offer API E2E suite (`tests/specs/services/gcp/offer_api.ts`) in the marketplace repo. |
| `server.mjs` | Serves the page and forwards API calls to dev or prod |
