declare module "razorpay" {
  export interface RazorpayOrder {
    id: string
    amount: number
    currency: string
  }

  export interface RazorpayPayment {
    id: string
    amount: number
    currency: string
    status: string
    order_id?: string
    [key: string]: any
  }

  export interface RazorpayOrderListPaymentsResponse {
    count: number
    items: RazorpayPayment[]
  }

  export interface OrdersResource {
    create(params: Record<string, any>): Promise<RazorpayOrder>
    fetchPayments(orderId: string): Promise<RazorpayOrderListPaymentsResponse>
  }

  export interface PaymentsResource {
    fetch(paymentId: string): Promise<RazorpayPayment>
    refund(paymentId: string, params?: Record<string, any>): Promise<any>
  }

  export interface RefundsResource {
    create(params: Record<string, any>): Promise<any>
  }

  export interface RazorpayInstance {
    orders: OrdersResource
    payments: PaymentsResource
    refunds: RefundsResource
  }

  export interface RazorpayCtor {
    new (options: { key_id: string; key_secret: string }): RazorpayInstance
  }

  const Razorpay: RazorpayCtor
  export = Razorpay
}
