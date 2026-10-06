// Payload builders for the GCP private-offer demo. Loaded by index.html in the browser and by
// verify.mjs in Node, so the payload the demo sends is the payload that was verified.
//
// Shapes mirror what the console sends:
//   new offer  -> tests/specs/services/gcp/offer_api.ts (+ test_files/gcp_create_offer_api_base.json)
//   amendment  -> apps/web-react/src/components/gcp/CreateReplacementOfferFormV2.tsx
//                 (buildAmendmentDraftOffer + getOfferToCreate)
(function (root) {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function utcMidnight(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
  }

  function daysFromToday(days) {
    return utcMidnight(new Date(Date.now() + days * DAY_MS));
  }

  function stripBillingAccountPrefix(account) {
    return (account || "").replace(/billingAccounts\//g, "");
  }

  function productPlans(product) {
    return product?.info?.gcpProduct?.listingSpec?.purchaseSpec?.purchaseOptionSpecs || [];
  }

  // ---- Case 1: brand-new private offer ------------------------------------------------------
  //
  // params: { orgId, product, planName, billingAccount, offerName, recurrence, duration,
  //           amount, discountPercentage, usagePlanPriceModel, expireInDays,
  //           customerOrganization, contactName, salesContactEmail }
  function buildNewPrivateOffer(params) {
    const plan = productPlans(params.product).find((p) => p.name === params.planName);
    if (!plan) throw new Error(`product ${params.product?.id} has no plan "${params.planName}"`);
    const isUsagePlan = plan.priceInfo?.priceModel === "USAGE";
    const usagePlanPriceModel = isUsagePlan ? params.usagePlanPriceModel || "USAGE_DISCOUNT_ONLY" : undefined;
    const discountOnly = usagePlanPriceModel === "USAGE_DISCOUNT_ONLY";

    const info = {
      eulaType: "SCMP",
      currency: "USD",
      visibility: "PRIVATE",
      paymentInstallments: [],
      gcpPlans: [plan],
      gcpCustomerInfo: {
        organization: params.customerOrganization || "Demo Customer",
        contact: params.contactName || "",
        email: params.salesContactEmail || "",
        address: "",
        unverifiedBillingAccount: stripBillingAccountPrefix(params.billingAccount),
      },
      gcpProviderInfo: {
        creatorEmailAddress: params.salesContactEmail || "",
        salesContactName: params.contactName || params.salesContactEmail || "",
        salesContactEmail: params.salesContactEmail || "",
      },
      gcpPaymentRecurrence: params.recurrence,
      gcpDuration: Number(params.duration),
      gcpProviderPublicNote: params.offerName,
      gcpProviderInternalNote: "Created by the GCP private offer API demo",
    };
    if (usagePlanPriceModel) info.gcpUsagePlanPriceModel = usagePlanPriceModel;
    // USAGE_DISCOUNT_ONLY has no flat fee or commitment to charge.
    if (!discountOnly) info.commitAmount = Number(params.amount);
    // A blanket usage discount only means something on a plan that carries usage.
    if (plan.priceInfo?.priceModel !== "SUBSCRIPTION" && Number(params.discountPercentage) > 0) {
      info.discountPercentage = Number(params.discountPercentage);
    }

    return {
      id: "",
      organizationID: params.orgId,
      productID: params.product.id,
      partner: "GCP",
      partnerID: "",
      service: "MARKETPLACE",
      offerType: "PRIVATE",
      name: params.offerName,
      expireTime: daysFromToday(Number(params.expireInDays || 6)),
      info,
      metaInfo: {},
      contactIds: [],
    };
  }

  // ---- Case 2: amendment (replacement) of the offer behind an entitlement --------------------

  // The base offer's usage price model. info.gcpUsagePlanPriceModel is authoritative; a synced
  // offer may only carry GCP's priceModel, so derive from it the way the console does.
  function baseUsagePlanPriceModel(baseOffer) {
    if (baseOffer.info?.gcpUsagePlanPriceModel) return baseOffer.info.gcpUsagePlanPriceModel;
    const priceModel = baseOffer.info?.gcpPrivateOffer?.priceModel;
    if (!priceModel) return undefined;
    if (priceModel.payg && !priceModel.commitment) return "USAGE_DISCOUNT_ONLY";
    if (priceModel.commitment && priceModel.payg?.discount) return "CUD_ALL_USAGE_DISCOUNTED";
    if (priceModel.commitment) return "CUD_LIST_PRICE";
    return undefined;
  }

  function baseDiscountPercentage(baseOffer) {
    if (baseOffer.info?.discountPercentage != null) return baseOffer.info.discountPercentage;
    const pct = baseOffer.info?.gcpPrivateOffer?.priceModel?.payg?.discount?.discountPercentage;
    return pct ? Number(pct.units || 0) + Number(pct.nanos || 0) / 1e9 : 0;
  }

  // Everything the page shows about the live offer before building the replacement.
  function describeBase(entitlement, baseOffer) {
    const gcp = baseOffer.info?.gcpPrivateOffer || {};
    const gcpEntitlements = entitlement.info?.gcpEntitlements || [];
    const latest = gcpEntitlements[gcpEntitlements.length - 1] || {};
    return {
      entitlementId: entitlement.id,
      entitlementStatus: entitlement.status,
      baseOfferId: baseOffer.id,
      baseOfferName: gcp.offerTitle || baseOffer.name,
      baseOfferState: gcp.offerState,
      planName: (latest.plan || gcp.serviceLevel || "").replace(/-P1Y$/, ""),
      billingAccount: stripBillingAccountPrefix(gcp.customerInfo?.unverifiedBillingAccount),
      usagePlanPriceModel: baseUsagePlanPriceModel(baseOffer),
      recurrence: baseOffer.info?.gcpPaymentRecurrence || gcp.offerTerm?.paymentRecurrence || "",
      duration: baseOffer.info?.gcpDuration ?? gcp.offerTerm?.termDuration?.count,
      discountPercentage: baseDiscountPercentage(baseOffer),
      // MaaS entitlements leave gcpEntitlements[].offer empty; fall back to the offer's own name.
      replacedOfferResourceName: latest.offer || gcp.name,
      // The replaced offer's own term end is GCP's raw value; entitlement.endTime is the fallback.
      replacedOfferEndTime: gcp.offerTerm?.endTime || entitlement.endTime,
    };
  }

  // The replacement must expire before the replaced offer's next installment is charged
  // (charge day - 1 day; see partner/gcp/util.go ToGcpMarketplaceExpireTime).
  function amendmentExpireTime(baseOffer, expireInDays) {
    let expire = new Date(daysFromToday(Number(expireInDays || 5)));
    const nextCharge = (baseOffer.info?.paymentInstallments || [])
      .map((i) => i.chargeOn && new Date(i.chargeOn))
      .filter((d) => d && d.getTime() > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextCharge) {
      const latestAllowed = new Date(utcMidnight(new Date(nextCharge.getTime() - DAY_MS)));
      if (expire > latestAllowed) expire = latestAllowed;
    }
    return expire.toISOString();
  }

  // params: { entitlement, baseOffer, product, offerName, discountPercentage, duration, expireInDays }
  function buildAmendmentOffer(params) {
    const { entitlement, baseOffer, product } = params;
    const base = describeBase(entitlement, baseOffer);
    if (!base.billingAccount) throw new Error(`base offer ${baseOffer.id} has no billing account`);
    if (!base.replacedOfferResourceName) throw new Error(`cannot resolve the GCP name of offer ${baseOffer.id}`);
    const plan = productPlans(product).find((p) => p.name === base.planName);
    if (!plan) throw new Error(`product ${product.id} has no plan "${base.planName}"`);

    const gcp = baseOffer.info?.gcpPrivateOffer || {};
    const usagePlanPriceModel = plan.priceInfo?.priceModel === "USAGE" ? base.usagePlanPriceModel : undefined;
    const discountOnly = usagePlanPriceModel === "USAGE_DISCOUNT_ONLY";
    // USAGE_DISCOUNT_ONLY has no billing cadence; GCP needs Monthly + POSTPAY (console does the same).
    const recurrence = discountOnly ? "MONTHLY_PERIOD" : base.recurrence || "MONTHLY_PERIOD";
    if (recurrence === "CUSTOM_PERIOD") {
      throw new Error("this demo amends standard-interval offers only; the base offer uses custom installments");
    }

    const info = {
      // The console makes the seller pick; carry a custom EULA forward, else the standard one.
      eulaType: baseOffer.info?.eulaType === "CUSTOM" ? "CUSTOM" : "SCMP",
      eulaUrl: baseOffer.info?.eulaType === "CUSTOM" ? baseOffer.info.eulaUrl : undefined,
      currency: "USD",
      gcpPlans: [plan],
      gcpCustomerInfo: {
        unverifiedBillingAccount: base.billingAccount,
        organization: gcp.customerInfo?.organization || "",
        contact: gcp.customerInfo?.contact || "",
        email: gcp.customerInfo?.email || "",
      },
      // Keep the original deal's sales contact.
      gcpProviderInfo: {
        salesContactEmail: gcp.providerInfo?.salesContactEmail || "",
        salesContactName: gcp.providerInfo?.salesContactName || "",
      },
      paymentInstallments: [],
      gcpPaymentRecurrence: recurrence,
      // Not co-termed: on the Commerce API channel ALIGN_END_TIME becomes a fixed end date, and
      // GCP refuses an end date on monthly/quarterly/yearly billing
      // (partner/gcp/marketplace_offer_api_util.go errGcpAPIStandardIntervalNeedsDuration).
      // So the replacement runs for an explicit duration from acceptance -- the console's
      // "Change Offer Duration" path.
      gcpCotermAlignment: "COTERM_ALIGNMENT_UNSPECIFIED",
      gcpDuration: Number(params.duration || base.duration || 12),
      autoRenew: baseOffer.info?.autoRenew,
      gcpMaxRenewalTimes: baseOffer.info?.gcpMaxRenewalTimes,
      gcpProviderPublicNote: params.offerName,
    };
    if (gcp.proration) info.gcpPrivateOffer = { proration: gcp.proration };
    if (usagePlanPriceModel) info.gcpUsagePlanPriceModel = usagePlanPriceModel;
    if (discountOnly) info.gcpPaymentSchedule = "POSTPAY";
    if (!discountOnly && baseOffer.info?.commitAmount != null) info.commitAmount = baseOffer.info.commitAmount;
    if (Number(params.discountPercentage) > 0) info.discountPercentage = Number(params.discountPercentage);

    return {
      id: "",
      organizationID: entitlement.organizationID,
      productID: entitlement.productID,
      partner: "GCP",
      service: "MARKETPLACE",
      offerType: "PRIVATE",
      name: params.offerName,
      expireTime: amendmentExpireTime(baseOffer, params.expireInDays),
      info,
      metaInfo: {
        isReplacementOffer: true,
        replacedOfferResourceName: base.replacedOfferResourceName,
        replacedOfferEndTime: base.replacedOfferEndTime,
        replacedOfferPaymentRecurrence: base.recurrence || recurrence,
      },
      contactIds: [],
    };
  }

  const api = { buildNewPrivateOffer, buildAmendmentOffer, describeBase, productPlans };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OfferBuilders = api;
})(typeof window !== "undefined" ? window : globalThis);
