import { nextAvailableFriday, buildSignature, payfastHost } from './src/payfast.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/check-availability' && request.method === 'GET') {
      return handleCheckAvailability(env);
    }
    if (url.pathname === '/api/create-payment' && request.method === 'POST') {
      return handleCreatePayment(request, env);
    }
    if (url.pathname === '/api/payfast-notify' && request.method === 'POST') {
      return handlePayfastNotify(request, env);
    }

    // Anything else falls through to the static site (index.html, etc.)
    return env.ASSETS.fetch(request);
  },
};

async function handleCheckAvailability(env) {
  const booked = (await env.BOOKINGS_KV.get('booked-fridays', { type: 'json' })) || [];
  const date = nextAvailableFriday(booked);
  return new Response(JSON.stringify({ date, time: '13:00-14:00' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleCreatePayment(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
  }

  const name_first = (body.name_first || '').trim();
  const name_last = (body.name_last || '').trim();
  const email_address = (body.email_address || '').trim();

  if (!name_first || !email_address) {
    return new Response(JSON.stringify({ error: 'Name and email are required' }), { status: 400 });
  }

  const booked = (await env.BOOKINGS_KV.get('booked-fridays', { type: 'json' })) || [];
  const slotDate = nextAvailableFriday(booked);

  const origin = new URL(request.url).origin;
  const amount = env.PAYFAST_CONSULT_AMOUNT || '500.00'; // ZAR - set your real fee as an env var

  const fields = {
    merchant_id: (env.PAYFAST_MERCHANT_ID || '').trim(),
    merchant_key: (env.PAYFAST_MERCHANT_KEY || '').trim(),
    return_url: `${origin}/booking-confirmed?date=${slotDate}`,
    cancel_url: `${origin}/booking-cancelled?date=${slotDate}`,
    notify_url: `${origin}/api/payfast-notify`,
    name_first,
    name_last,
    email_address,
    m_payment_id: `${slotDate}-${Date.now()}`,
    amount: Number(amount).toFixed(2),
    item_name: 'Consultation booking',
    item_description: `Consultation - Friday ${slotDate}, 13:00-14:00`,
    custom_str1: slotDate,
  };

  const signature = await buildSignature(fields, env.PAYFAST_PASSPHRASE);

  return new Response(
    JSON.stringify({ action: payfastHost(env), fields: { ...fields, signature } }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handlePayfastNotify(request, env) {
  const bodyText = await request.text();
  const params = new URLSearchParams(bodyText);
  const data = Object.fromEntries(params.entries());
  const { signature, ...rest } = data;

  const expected = await buildSignature(rest, env.PAYFAST_PASSPHRASE);
  if (!signature || signature !== expected) {
    return new Response('Invalid signature', { status: 400 });
  }

  if (data.payment_status !== 'COMPLETE') {
    return new Response('Ignored - not complete', { status: 200 });
  }

  const slotDate = data.custom_str1;
  if (slotDate) {
    const booked = (await env.BOOKINGS_KV.get('booked-fridays', { type: 'json' })) || [];
    if (!booked.includes(slotDate)) {
      booked.push(slotDate);
      await env.BOOKINGS_KV.put('booked-fridays', JSON.stringify(booked));
    }
  }

  // Production hardening worth adding once you're live: verify the request
  // came from a PayFast IP, and post the received data back to PayFast's
  // validate endpoint to confirm authenticity before trusting it fully.
  // See: https://developers.payfast.co.za/docs#step_5_confirm_payment

  return new Response('OK', { status: 200 });
}
