import { Resend } from "resend";

export async function sendEmail({ to, subject, react }) {
    console.log("📧 sendEmail CALLED:", to);

    const resend = new Resend(process.env.RESEND_API_KEY);

    try {
        const data = await resend.emails.send({
            from: "Finance App <onboarding@resend.dev>",
            to: "asghetyt@gmail.com",
            subject,
            react,
        });

        console.log("✅ Email sent:", data);

        return { success: true, data };
    } catch (error) {
        console.error("❌ Failed to send email:", error);
        return { success: false, error };
    }
}