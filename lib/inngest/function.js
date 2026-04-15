import { inngest } from "./client";
import { db } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================================
   1. Recurring Transaction Processing
================================ */

export const processRecurringTransaction = inngest.createFunction(
  {
    id: "process-recurring-transaction",
    name: "Process Recurring Transaction",
    throttle: {
      limit: 10,
      period: "1m",
      key: "event.data.userId",
    },
  },
  { event: "transaction.recurring.process" },
  async ({ event, step }) => {
    if (!event?.data?.transactionId || !event?.data?.userId) {
      console.error("Invalid event data:", event);
      return;
    }

    await step.run("process-transaction", async () => {
      const transaction = await db.transaction.findFirst({
        where: {
          id: event.data.transactionId,
          userId: event.data.userId,
        },
        include: { account: true },
      });

      if (!transaction || !isTransactionDue(transaction)) return;

      await db.$transaction(async (tx) => {
        await tx.transaction.create({
          data: {
            type: transaction.type,
            amount: transaction.amount,
            description: `${transaction.description} (Recurring)`,
            date: new Date(),
            category: transaction.category,
            userId: transaction.userId,
            accountId: transaction.accountId,
            isRecurring: false,
          },
        });

        const balanceChange =
          transaction.type === "EXPENSE"
            ? -transaction.amount.toNumber()
            : transaction.amount.toNumber();

        await tx.account.update({
          where: { id: transaction.accountId },
          data: { balance: { increment: balanceChange } },
        });

        await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            lastProcessed: new Date(),
            nextRecurringDate: calculateNextRecurringDate(
              new Date(),
              transaction.recurringInterval
            ),
          },
        });
      });
    });
  }
);

/* ================================
   2. Trigger Recurring Transactions
================================ */

export const triggerRecurringTransactions = inngest.createFunction(
  {
    id: "trigger-recurring-transactions",
    name: "Trigger Recurring Transactions",
  },
  { cron: "0 0 * * *" },
  async ({ step }) => {
    const recurringTransactions = await step.run(
      "fetch-recurring-transactions",
      async () => {
        return await db.transaction.findMany({
          where: {
            isRecurring: true,
            status: "COMPLETED",
            OR: [
              { lastProcessed: null },
              {
                nextRecurringDate: {
                  lte: new Date(),
                },
              },
            ],
          },
        });
      }
    );

    if (recurringTransactions.length > 0) {
      const events = recurringTransactions.map((transaction) => ({
        name: "transaction.recurring.process",
        data: {
          transactionId: transaction.id,
          userId: transaction.userId,
        },
      }));

      await inngest.send(events);
    }

    return { triggered: recurringTransactions.length };
  }
);

/* ================================
   3. Monthly Report
================================ */

async function generateFinancialInsights(stats, month) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Analyze this financial data and provide 3 concise, actionable insights.

Financial Data for ${month}:
- Total Income: ₹${stats.totalIncome}
- Total Expenses: ₹${stats.totalExpenses}
- Net Income: ₹${stats.totalIncome - stats.totalExpenses}
- Expense Categories: ${Object.entries(stats.byCategory || {})
      .map(([c, a]) => `${c}: ₹${a}`)
      .join(", ")}

Return ONLY a JSON array:
["insight 1", "insight 2", "insight 3"]
`;

  try {
    const result = await model.generateContent(prompt);
    let text = result.response.text();

    // ✅ CLEAN MARKDOWN
    text = text.replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(text);
  } catch (err) {
    console.error("AI Error:", err);

    return [
      "Track your highest spending category.",
      "Try setting limits for discretionary expenses.",
      "Monitor recurring expenses carefully.",
    ];
  }
}

export const generateMonthlyReports = inngest.createFunction(
  {
    id: "generate-monthly-reports",
    name: "Generate Monthly Reports",
  },
  { cron: "0 0 1 * *" },
  async ({ step }) => {
    const users = await db.user.findMany();

    for (const user of users) {
      await step.run(`report-${user.id}`, async () => {

        // ✅ Get last month (same as old code)
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);

        const stats = await getMonthlyStats(user.id, lastMonth);

        const monthName = lastMonth.toLocaleString("default", {
          month: "long",
        });

        // ✅ AI insights (IMPORTANT)
        const insights = await generateFinancialInsights(stats, monthName);

        await sendEmail({
          to: user.email,
          subject: `📊 Your Monthly Financial Report - ${monthName}`,

          html: `
            <div style="font-family: Arial; padding: 20px;">

              <h2 style="color:#2563eb;">
                📊 ${monthName} Financial Report
              </h2>

              <p>Hi ${user.name || "User"},</p>

              <p>Here’s your financial summary for ${monthName}:</p>

              <div style="background:#eff6ff;padding:15px;border-radius:8px;margin:15px 0;">
                <p><b>Total Income:</b> ₹${stats.totalIncome}</p>
                <p><b>Total Expenses:</b> ₹${stats.totalExpenses}</p>
                <p><b>Net Income:</b> ₹${stats.totalIncome - stats.totalExpenses}</p>
              </div>

              <h3>💡 AI Insights</h3>

              <ul>
                ${insights.map(i => `<li>${i}</li>`).join("")}
              </ul>

              <h3>📂 Category Breakdown</h3>
              <ul>
                ${Object.entries(stats.byCategory)
              .map(([cat, amt]) => `<li>${cat}: ₹${amt}</li>`)
              .join("")}
              </ul>

              <hr />

              <p style="font-size:12px;color:gray;">
                Finance App • AI Powered Insights
              </p>

            </div>
          `,
        });
      });
    }
  }
);

/* ================================
   4. Budget Alert (CRON - BACKUP)
================================ */

export const checkBudgetAlerts = inngest.createFunction(
  {
    id: "check-budget-alerts",
    name: "Check Budget Alerts",
  },
  { cron: "0 */6 * * *" },
  async () => {
    console.log("⏰ Cron budget check running");

    const budgets = await db.budget.findMany({
      include: { user: true },
    });

    for (const budget of budgets) {
      const expenses = await db.transaction.aggregate({
        where: {
          userId: budget.userId,
          type: "EXPENSE",
        },
        _sum: { amount: true },
      });

      const total = expenses._sum.amount?.toNumber() || 0;
      const percent = (total / budget.amount) * 100;

      if (percent >= 80) {
        await sendEmail({
          to: budget.user.email,
          subject: "⚠️ Budget Alert",
          html: `
    <div style="font-family: Arial; padding: 20px;">
      
      <h2 style="color:#e11d48;">⚠️ Budget Alert</h2>

      <p>Hi ${budget.user.name || "User"},</p>

      <p>You’ve used <b>${percent.toFixed(1)}%</b> of your budget.</p>

      <div style="background:#fef2f2;padding:15px;border-radius:8px;margin:15px 0;">
        <p><b>Total Spent:</b> ₹${total}</p>
        <p><b>Budget Limit:</b> ₹${budget.amount}</p>
      </div>

      <p style="color:#555;">
        Try reducing spending to stay within your budget.
      </p>

      <hr />

      <p style="font-size:12px;color:gray;">
        Finance App • Budget Tracking
      </p>

    </div>
  `,
        });
      }
    }
  }
);

/* ================================
   5. Budget Alert (REAL-TIME) 🔥
================================ */

export const budgetAlertOnTransaction = inngest.createFunction(
  {
    id: "budget-alert-on-transaction",
    name: "Budget Alert On Transaction",
  },
  { event: "budget.check" },
  async ({ event }) => {
    console.log("⚡ Real-time budget alert triggered");

    const { userId } = event.data;

    const budgets = await db.budget.findMany({
      where: { userId },
      include: { user: true },
    });

    for (const budget of budgets) {
      const expenses = await db.transaction.aggregate({
        where: {
          userId,
          type: "EXPENSE",
        },
        _sum: { amount: true },
      });

      const total = expenses._sum.amount?.toNumber() || 0;
      const percent = (total / budget.amount) * 100;

      if (percent >= 80) {
        await sendEmail({
          to: budget.user.email,
          subject: "⚠️ Budget Alert",
          html: `
    <div style="font-family: Arial; padding: 20px;">
      
      <h2 style="color:#e11d48;">⚠️ Budget Alert</h2>

      <p>Hi ${budget.user.name || "User"},</p>

      <p>You’ve used <b>${percent.toFixed(1)}%</b> of your budget.</p>

      <div style="background:#fef2f2;padding:15px;border-radius:8px;margin:15px 0;">
        <p><b>Total Spent:</b> ₹${total}</p>
        <p><b>Budget Limit:</b> ₹${budget.amount}</p>
      </div>

      <p style="color:#555;">
        Try reducing spending to stay within your budget.
      </p>

      <hr />

      <p style="font-size:12px;color:gray;">
        Finance App • Budget Tracking
      </p>

    </div>
  `,
        });
      }
    }
  }
);

/* ================================
   Helpers
================================ */

function isTransactionDue(transaction) {
  if (!transaction.lastProcessed) return true;
  return new Date(transaction.nextRecurringDate) <= new Date();
}

function calculateNextRecurringDate(date, interval) {
  const next = new Date(date);
  if (interval === "MONTHLY") next.setMonth(next.getMonth() + 1);
  return next;
}

async function getMonthlyStats(userId, month) {
  const startDate = new Date(month.getFullYear(), month.getMonth(), 1);
  const endDate = new Date(month.getFullYear(), month.getMonth() + 1, 0);

  const transactions = await db.transaction.findMany({
    where: {
      userId,
      date: {
        gte: startDate,
        lte: endDate,
      },
    },
  });

  return transactions.reduce(
    (stats, t) => {
      const amount = t.amount.toNumber();

      if (t.type === "EXPENSE") {
        stats.totalExpenses += amount;
        stats.byCategory[t.category] =
          (stats.byCategory[t.category] || 0) + amount;
      } else {
        stats.totalIncome += amount;
      }

      return stats;
    },
    {
      totalExpenses: 0,
      totalIncome: 0,
      byCategory: {}, // ✅ IMPORTANT
      transactionCount: transactions.length,
    }
  );
}