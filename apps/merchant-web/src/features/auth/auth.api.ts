import z from "zod";

export const SignInRequestBodySchema = z.object({
  email: z.email(),
  password: z.string(),
});

export type SignInRequestBody = z.infer<typeof SignInRequestBodySchema>;

export const SignInResponseSchema = z.object({access_token: z.string()})

export type SignInResponse = z.infer<typeof SignInResponseSchema>

export const SignUpRequestBodySchema = z.object({
  businessName: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.email(),
  phone: z.string().min(1),
  // mirrors merchant-api's SignUpDto: @MinLength(12) + a zxcvbn/HIBP floor
  // (OS-317) the API enforces server-side — this only catches the too-short
  // case early, actual strength/breach rejection still comes from the API.
  password: z.string().min(12),
});

export type SignUpRequestBody = z.infer<typeof SignUpRequestBodySchema>

export const AcceptInviteRequestBodySchema = z.object({
  token: z.string(),
  password: z.string().min(12),
});

export type AcceptInviteRequestBody = z.infer<typeof AcceptInviteRequestBodySchema>