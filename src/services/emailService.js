const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@clayworthpharmacy.com';
const FROM_NAME  = process.env.FROM_NAME  || 'Clayworth Pharmacy';
const PORTAL_URL = process.env.PORTAL_URL || 'https://medroute-dashboard.vercel.app/portal';

async function sendPatientWelcome(patient) {
  const msg = {
    to:   patient.email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Your Clayworth Pharmacy Delivery Portal',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px">
        <div style="background:#1D9E75;padding:20px;border-radius:10px 10px 0 0;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:22px">Clayworth Pharmacy</h1>
          <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px">Medication Delivery Service</p>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 10px 10px">
          <p style="font-size:16px;color:#333">Hello ${patient.firstName},</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            You have been registered for medication delivery from Clayworth Pharmacy.
            You can track your deliveries in real time using our online portal.
          </p>
          <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin:20px 0">
            <p style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px">Your login details</p>
            <p style="font-size:14px;color:#333;margin:4px 0"><strong>Email:</strong> ${patient.email}</p>
            <p style="font-size:14px;color:#333;margin:4px 0"><strong>Password:</strong> Your date of birth (YYYY-MM-DD)</p>
          </div>
          <div style="text-align:center;margin:24px 0">
            <a href="${PORTAL_URL}" style="background:#1D9E75;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600">
              Track My Delivery
            </a>
          </div>
          <p style="font-size:12px;color:#888;line-height:1.6">
            If you have any questions please contact us at Clayworth Pharmacy.
            This email was sent because you were registered for our delivery service.
          </p>
        </div>
      </div>
    `
  };

  try {
    await sgMail.send(msg);
    console.log('Welcome email sent to', patient.email);
    return true;
  } catch (err) {
    console.error('Email send failed:', err.response?.body || err.message);
    return false;
  }
}

async function sendDeliveryNotification(patient, packages) {
  const itemList = packages.map(p => 
    '<li style="padding:4px 0;font-size:14px;color:#555">' + p.medication + ' ' + p.dosage + ' — RX: ' + p.rxId + '</li>'
  ).join('');

  const msg = {
    to:   patient.email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Your medication is out for delivery',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px">
        <div style="background:#1D9E75;padding:20px;border-radius:10px 10px 0 0;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:22px">Delivery Update</h1>
          <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px">Clayworth Pharmacy</p>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 10px 10px">
          <p style="font-size:16px;color:#333">Hello ${patient.firstName},</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            Your medication is on its way. Your driver is heading to you now.
          </p>
          <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin:20px 0">
            <p style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px">Items being delivered</p>
            <ul style="margin:0;padding-left:20px">${itemList}</ul>
          </div>
          <div style="text-align:center;margin:24px 0">
            <a href="${PORTAL_URL}" style="background:#1D9E75;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600">
              Track My Delivery
            </a>
          </div>
        </div>
      </div>
    `
  };

  try {
    await sgMail.send(msg);
    console.log('Delivery notification sent to', patient.email);
    return true;
  } catch (err) {
    console.error('Email send failed:', err.response?.body || err.message);
    return false;
  }
}

module.exports = { sendPatientWelcome, sendDeliveryNotification };
