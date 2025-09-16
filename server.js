const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage for recent failures (in production, use a database)
let recentFailures = [];
let logs = [];

// Gmail transporter setup
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_EMAIL || 'your-email@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD
  }
});

// Logging function
function addLog(level, message, data = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
    id: Date.now()
  };
  logs.unshift(logEntry);
  if (logs.length > 100) logs.pop(); // Keep only last 100 logs
  console.log(`[${level}] ${message}`, data ? data : '');
}

// Send email alert
async function sendFailureAlert(paymentIntent) {
  try {
    const customer = paymentIntent.customer ? 
      await stripe.customers.retrieve(paymentIntent.customer) : null;
    
    const emailContent = {
      from: process.env.GMAIL_EMAIL || 'your-email@gmail.com',
      to: process.env.ALERT_EMAIL || process.env.GMAIL_EMAIL || 'your-email@gmail.com',
      subject: `🚨 Payment Failure Alert - $${(paymentIntent.amount / 100).toFixed(2)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #dc3545;">💳 Payment Failed</h2>
          <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3>Payment Details</h3>
            <p><strong>Amount:</strong> $${(paymentIntent.amount / 100).toFixed(2)} ${paymentIntent.currency.toUpperCase()}</p>
            <p><strong>Payment ID:</strong> ${paymentIntent.id}</p>
            <p><strong>Status:</strong> ${paymentIntent.status}</p>
            <p><strong>Failure Code:</strong> ${paymentIntent.last_payment_error?.code || 'Unknown'}</p>
            <p><strong>Failure Message:</strong> ${paymentIntent.last_payment_error?.message || 'No specific error message'}</p>
            <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          </div>
          
          ${customer ? `
          <div style="background: #e9ecef; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3>Customer Information</h3>
            <p><strong>Name:</strong> ${customer.name || 'Not provided'}</p>
            <p><strong>Email:</strong> ${customer.email || 'Not provided'}</p>
            <p><strong>Customer ID:</strong> ${customer.id}</p>
          </div>
          ` : ''}
          
          <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Recommended Actions:</strong></p>
            <ul>
              <li>Contact the customer to update payment method</li>
              <li>Review the failure reason for patterns</li>
              <li>Check if this is a recurring issue</li>
            </ul>
          </div>
          
          <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">
            This alert was sent by your Stripe Payment Monitor Agent
          </p>
        </div>
      `
    };

    await transporter.sendMail(emailContent);
    addLog('INFO', 'Failure alert email sent successfully', {
      paymentId: paymentIntent.id,
      amount: paymentIntent.amount / 100,
      recipient: emailContent.to
    });
  } catch (error) {
    addLog('ERROR', 'Failed to send email alert', {
      error: error.message,
      paymentId: paymentIntent.id
    });
  }
}

// Standard endpoints
app.get('/', (req, res) => {
  res.json({
    status: 'active',
    service: 'Stripe Failed Payment Monitor',
    endpoints: {
      'GET /': 'Service status and endpoints',
      'GET /health': 'Health check',
      'GET /logs': 'View recent logs',
      'GET /failures': 'View recent failures',
      'POST /webhook/stripe': 'Stripe webhook endpoint',
      'POST /test': 'Manual test run',
      'POST /test-email': 'Test email functionality'
    },
    recentFailures: recentFailures.length,
    totalLogs: logs.length,
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    recentFailures: recentFailures.length
  });
});

app.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    logs: logs.slice(0, limit),
    total: logs.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/failures', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({
    failures: recentFailures.slice(0, limit),
    total: recentFailures.length,
    timestamp: new Date().toISOString()
  });
});

// Main Stripe webhook endpoint
app.post('/webhook/stripe', async (req, res) => {
  let event;

  try {
    event = req.body;
    
    // Handle the event
    switch (event.type) {
      case 'payment_intent.payment_failed':
        const paymentIntent = event.data.object;
        
        addLog('WARNING', 'Payment failed detected', {
          paymentId: paymentIntent.id,
          amount: paymentIntent.amount / 100,
          currency: paymentIntent.currency,
          customer: paymentIntent.customer,
          errorCode: paymentIntent.last_payment_error?.code,
          errorMessage: paymentIntent.last_payment_error?.message
        });

        // Store failure
        recentFailures.unshift({
          id: paymentIntent.id,
          amount: paymentIntent.amount / 100,
          currency: paymentIntent.currency,
          customer: paymentIntent.customer,
          errorCode: paymentIntent.last_payment_error?.code || 'unknown',
          errorMessage: paymentIntent.last_payment_error?.message || 'No error message',
          timestamp: new Date().toISOString(),
          status: paymentIntent.status
        });
        
        if (recentFailures.length > 50) recentFailures.pop();

        // Send email alert
        await sendFailureAlert(paymentIntent);
        break;

      case 'invoice.payment_failed':
        const invoice = event.data.object;
        
        addLog('WARNING', 'Invoice payment failed', {
          invoiceId: invoice.id,
          amount: invoice.amount_due / 100,
          customer: invoice.customer
        });

        // Store failure
        recentFailures.unshift({
          id: invoice.id,
          type: 'invoice',
          amount: invoice.amount_due / 100,
          currency: invoice.currency,
          customer: invoice.customer,
          errorCode: 'invoice_payment_failed',
          errorMessage: 'Invoice payment failed',
          timestamp: new Date().toISOString(),
          status: invoice.status
        });
        
        if (recentFailures.length > 50) recentFailures.pop();
        break;

      default:
        addLog('INFO', `Unhandled event type: ${event.type}`);
    }

    res.json({ received: true, eventType: event.type });
  } catch (err) {
    addLog('ERROR', 'Webhook processing error', { error: err.message });
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Manual test endpoint
app.post('/test', async (req, res) => {
  try {
    addLog('INFO', 'Manual test initiated');
    
    // Create a mock failed payment for testing
    const mockFailure = {
      id: 'pi_test_' + Date.now(),
      amount: 2500, // $25.00
      currency: 'usd',
      customer: 'cus_test_customer',
      last_payment_error: {
        code: 'card_declined',
        message: 'Your card was declined.'
      },
      status: 'requires_payment_method'
    };

    // Send test alert
    await sendFailureAlert(mockFailure);
    
    res.json({
      success: true,
      message: 'Test alert sent successfully',
      testData: mockFailure
    });
  } catch (error) {
    addLog('ERROR', 'Test failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test email functionality
app.post('/test-email', async (req, res) => {
  try {
    const testEmail = {
      from: process.env.GMAIL_EMAIL,
      to: process.env.ALERT_EMAIL || process.env.GMAIL_EMAIL,
      subject: '🧪 Test Email from Stripe Monitor',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>✅ Email Test Successful</h2>
          <p>This is a test email from your Stripe Failed Payment Monitor agent.</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Agent Status:</strong> Active and monitoring</p>
          <p>If you're receiving this email, your email alerts are working correctly!</p>
        </div>
      `
    };

    await transporter.sendMail(testEmail);
    addLog('INFO', 'Test email sent successfully');
    
    res.json({
      success: true,
      message: 'Test email sent successfully',
      recipient: testEmail.to
    });
  } catch (error) {
    addLog('ERROR', 'Test email failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  addLog('ERROR', 'Express error', { error: error.message, path: req.path });
  res.status(500).json({ error: 'Internal server error', message: error.message });
});

app.listen(port, () => {
  addLog('INFO', `Stripe Failed Payment Monitor started on port ${port}`);
  console.log(`🚀 Stripe Failed Payment Monitor running on port ${port}`);
});

module.exports = app;