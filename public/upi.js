/* UPI payment links. A link names who gets paid (pa: their UPI ID, pn: their name) and, when known,
   the amount, so the payer's UPI app opens with everything filled in and they only enter their PIN.
   UPI is rupees only, so callers offer it only on ₹ bills. */
export const VPA = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
const NOTE = 'Bill split';

/* `upi://pay` opens the phone's UPI app (Android asks which one). iPhones send it to whichever app claimed it,
   so there each app also gets its own link.
   Icons are each app's own App Store icon, in icons/. */
export const APPS = [
  ['Google Pay', 'gpay://upi/pay', 'gpay'],
  ['PhonePe', 'phonepe://pay', 'phonepe'],
  ['super.money', 'super://pay', 'supermoney'],   // tried on an iPhone: super://upi/pay opens the app without the amount
  ['BHIM', 'bhim://upi/pay', 'bhim'],
];
export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function link({ pa, pn }, amountCents, base = 'upi://pay', note = NOTE) {
  const q = new URLSearchParams({ pa, pn: pn || pa });
  if (amountCents > 0) q.set('am', (amountCents / 100).toFixed(2));
  q.set('cu', 'INR');
  q.set('tn', note);
  // UPI apps read %20, not the + that URLSearchParams writes for a space, and some don't read %40 for the @.
  return `${base}?${q.toString().replace(/\+/g, '%20').replace(/%40/g, '@')}`;
}

/* One icon button per app, for iPhones. Empty elsewhere: Android's own chooser lists the apps. */
export function appButtons(payee, amountCents, note) {
  if (!isIOS()) return '';
  const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<div class="apps">${APPS.map(([name, base, icon]) => `<a class="app" href="${attr(link(payee, amountCents, base, note))}" aria-label="Pay with ${name}" title="${name}">
    <img src="icons/${icon}.png" alt="" width="44" height="44"></a>`).join('')}</div>`;
}

/* A web page that opens the UPI app: unlike upi:// links, it can be tapped in a chat app. */
export function pageLink(payee, amountCents) {
  return link(payee, amountCents, new URL('pay.html', location.href).href);
}
