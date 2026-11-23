/* UPI payment links. A link names who gets paid (pa: their UPI ID, pn: their name) and, when known,
   the amount, so the payer's UPI app opens with everything filled in and they only enter their PIN.
   UPI is rupees only, so callers offer it only on ₹ bills. */
export const VPA = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
const NOTE = 'Bill split';

/* `upi://pay` opens the phone's UPI app (Android asks which one). iPhones send it to whichever app claimed it,
   so there each app also gets its own link. */
export const APPS = [
  ['GPay', 'gpay://upi/pay'],
  ['PhonePe', 'phonepe://pay'],
  ['Paytm', 'paytmmp://pay'],
  ['BHIM', 'bhim://upi/pay'],
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

/* A web page that opens the UPI app: unlike upi:// links, it can be tapped in a chat app. */
export function pageLink(payee, amountCents) {
  return link(payee, amountCents, new URL('pay.html', location.href).href);
}
