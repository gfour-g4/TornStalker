const store = require('../services/store');
const api = require('../services/api');
const { notify } = require('../services/notify');
const Embeds = require('../discord/embeds');

/**
 * Poll company employees for addiction tracking
 */
async function pollCompany() {
  const { addiction } = store.self;
  
  if (!addiction.enabled) return;
  
  try {
    const ownerId = store.ownerId || api.getOwnerId();
    if (!ownerId) {
      console.warn('[company] Owner ID not set');
      return;
    }
    
    const employees = await api.getCompanyEmployees();
    const self = employees[String(ownerId)];
    
    if (!self) {
      console.warn('[company] Self not found in company employees');
      return;
    }
    
    const currentAddiction = self.effectiveness?.addiction ?? 0;
    const threshold = addiction.threshold ?? -5;
    const prevAddiction = addiction.last;
    
    // Update last known value
    addiction.last = currentAddiction;
    
    // Check if we need to alert
    const isBelowThreshold = currentAddiction <= threshold;
    const wasBelowThreshold = prevAddiction !== null && prevAddiction <= threshold;
    
    if (isBelowThreshold && !addiction.notified) {
      // Just dropped below threshold
      await notify(Embeds.addictionAlert(currentAddiction, threshold, self));
      addiction.notified = true;
      console.log(`[company] Addiction alert: ${currentAddiction} <= ${threshold}`);
    } else if (!isBelowThreshold && addiction.notified) {
      // Recovered above threshold
      await notify(Embeds.addictionRecovered(currentAddiction, threshold));
      addiction.notified = false;
      console.log(`[company] Addiction recovered: ${currentAddiction} > ${threshold}`);
    }
    
    store.save('company');
  } catch (error) {
    // Might not be in a company
    if (error.message.includes('company')) {
      console.log('[company] Not in a company');
    } else {
      console.warn('[company]', error.message);
    }
  }
}

module.exports = {
  pollCompany,
};