import { OrderStatus, ParcelStatus, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { assertAllBelongToOrg } from '../repositories/tenant.repository';

// --- products --------------------------------------------------------------

export interface ListProductsParams {
  page: number;
  pageSize: number;
  search?: string;
  category?: string;
  isActive?: boolean;
}

export async function listProducts(organizationId: string, params: ListProductsParams) {
  const where: Prisma.ProductWhereInput = { organizationId };
  if (params.search) {
    where.OR = [
      { name: { contains: params.search, mode: 'insensitive' } },
      { sku: { contains: params.search, mode: 'insensitive' } },
      { description: { contains: params.search, mode: 'insensitive' } },
    ];
  }
  if (params.category) where.category = params.category;
  if (params.isActive !== undefined) where.isActive = params.isActive;

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  return { items, total };
}

export async function getProduct(organizationId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, organizationId },
    include: {
      orderItems: {
        take: 20,
        orderBy: { order: { placedAt: 'desc' } },
        include: {
          order: { select: { id: true, orderNumber: true, status: true, placedAt: true } },
        },
      },
    },
  });
  if (!product) throw new NotFoundError('Product');
  return product;
}

export interface ProductInput {
  name: string;
  sku?: string | null;
  description?: string | null;
  price: number;
  compareAtPrice?: number | null;
  currency?: string;
  stock?: number;
  trackInventory?: boolean;
  category?: string | null;
  imageUrl?: string | null;
  isActive?: boolean;
}

export async function createProduct(organizationId: string, input: ProductInput) {
  return prisma.product.create({ data: { organizationId, ...input } });
}

export async function updateProduct(
  organizationId: string,
  productId: string,
  input: Partial<ProductInput>,
) {
  const result = await prisma.product.updateMany({
    where: { id: productId, organizationId },
    data: input,
  });
  if (result.count === 0) throw new NotFoundError('Product');
  return prisma.product.findFirstOrThrow({ where: { id: productId, organizationId } });
}

export async function deleteProduct(organizationId: string, productId: string) {
  const result = await prisma.product.deleteMany({ where: { id: productId, organizationId } });
  if (result.count === 0) throw new NotFoundError('Product');
}

// --- orders ----------------------------------------------------------------

const orderInclude = {
  items: { include: { product: { select: { id: true, name: true, imageUrl: true } } } },
  contact: { select: { id: true, displayName: true, avatarUrl: true, phone: true, email: true } },
  parcels: true,
  conversation: { select: { id: true, platform: true } },
} satisfies Prisma.OrderInclude;

export interface ListOrdersParams {
  page: number;
  pageSize: number;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  search?: string;
  contactId?: string;
}

export async function listOrders(organizationId: string, params: ListOrdersParams) {
  const where: Prisma.OrderWhereInput = { organizationId };
  if (params.status) where.status = params.status;
  if (params.paymentStatus) where.paymentStatus = params.paymentStatus;
  if (params.contactId) where.contactId = params.contactId;
  if (params.search) {
    where.OR = [
      { orderNumber: { contains: params.search, mode: 'insensitive' } },
      { customerName: { contains: params.search, mode: 'insensitive' } },
      { customerPhone: { contains: params.search, mode: 'insensitive' } },
      { customerEmail: { contains: params.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: orderInclude,
      orderBy: { placedAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return { items, total };
}

export async function getOrder(organizationId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, organizationId },
    include: orderInclude,
  });
  if (!order) throw new NotFoundError('Order');
  return order;
}

export interface OrderItemInput {
  productId?: string | null;
  name?: string;
  sku?: string | null;
  quantity: number;
  unitPrice?: number;
}

export interface OrderInput {
  contactId?: string | null;
  conversationId?: string | null;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  currency?: string;
  discount?: number;
  shippingFee?: number;
  tax?: number;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  shippingAddress?: string | null;
  city?: string | null;
  postalCode?: string | null;
  note?: string | null;
  items: OrderItemInput[];
}

/** Sequential per-organization order numbers: UC-000001, UC-000002, … */
async function nextOrderNumber(organizationId: string): Promise<string> {
  const count = await prisma.order.count({ where: { organizationId } });
  return `UC-${String(count + 1).padStart(6, '0')}`;
}

export async function createOrder(organizationId: string, input: OrderInput) {
  if (!input.items.length) throw new BadRequestError('An order needs at least one line item');

  const productIds = input.items
    .map((i) => i.productId)
    .filter((id): id is string => Boolean(id));
  await assertAllBelongToOrg('product', organizationId, productIds, 'Product');

  if (input.contactId) await assertAllBelongToOrg('contact', organizationId, [input.contactId], 'Contact');
  if (input.conversationId) {
    await assertAllBelongToOrg('conversation', organizationId, [input.conversationId], 'Conversation');
  }

  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds }, organizationId } })
    : [];

  const lines = input.items.map((item) => {
    const product = products.find((p) => p.id === item.productId);
    const unitPrice = item.unitPrice ?? (product ? Number(product.price) : 0);
    const name = item.name ?? product?.name ?? 'Item';
    return {
      organizationId,
      productId: item.productId ?? null,
      name,
      sku: item.sku ?? product?.sku ?? null,
      quantity: item.quantity,
      unitPrice: new Prisma.Decimal(unitPrice),
      total: new Prisma.Decimal(unitPrice * item.quantity),
    };
  });

  const subtotal = lines.reduce((sum, l) => sum + Number(l.total), 0);
  const total = subtotal - (input.discount ?? 0) + (input.shippingFee ?? 0) + (input.tax ?? 0);

  const order = await prisma.order.create({
    data: {
      organizationId,
      orderNumber: await nextOrderNumber(organizationId),
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      status: input.status ?? OrderStatus.PENDING,
      paymentStatus: input.paymentStatus ?? PaymentStatus.UNPAID,
      currency: input.currency ?? 'USD',
      subtotal: new Prisma.Decimal(subtotal),
      discount: new Prisma.Decimal(input.discount ?? 0),
      shippingFee: new Prisma.Decimal(input.shippingFee ?? 0),
      tax: new Prisma.Decimal(input.tax ?? 0),
      total: new Prisma.Decimal(Math.max(0, total)),
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail,
      shippingAddress: input.shippingAddress,
      city: input.city,
      postalCode: input.postalCode,
      note: input.note,
      items: { create: lines },
    },
    include: orderInclude,
  });

  // Reserve stock for tracked products.
  await Promise.all(
    input.items
      .filter((i) => i.productId)
      .map((i) =>
        prisma.product.updateMany({
          where: { id: i.productId!, organizationId, trackInventory: true },
          data: { stock: { decrement: i.quantity } },
        }),
      ),
  );

  return order;
}

export async function updateOrder(
  organizationId: string,
  orderId: string,
  input: Partial<Omit<OrderInput, 'items'>>,
) {
  const result = await prisma.order.updateMany({
    where: { id: orderId, organizationId },
    data: {
      status: input.status,
      paymentStatus: input.paymentStatus,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail,
      shippingAddress: input.shippingAddress,
      city: input.city,
      postalCode: input.postalCode,
      note: input.note,
      ...(input.discount !== undefined ? { discount: new Prisma.Decimal(input.discount) } : {}),
      ...(input.shippingFee !== undefined ? { shippingFee: new Prisma.Decimal(input.shippingFee) } : {}),
      ...(input.tax !== undefined ? { tax: new Prisma.Decimal(input.tax) } : {}),
    },
  });
  if (result.count === 0) throw new NotFoundError('Order');

  if (input.discount !== undefined || input.shippingFee !== undefined || input.tax !== undefined) {
    await recalculateOrderTotal(organizationId, orderId);
  }

  return getOrder(organizationId, orderId);
}

async function recalculateOrderTotal(organizationId: string, orderId: string) {
  const order = await prisma.order.findFirstOrThrow({
    where: { id: orderId, organizationId },
    include: { items: true },
  });
  const subtotal = order.items.reduce((sum, i) => sum + Number(i.total), 0);
  const total = subtotal - Number(order.discount) + Number(order.shippingFee) + Number(order.tax);
  await prisma.order.update({
    where: { id: orderId },
    data: { subtotal: new Prisma.Decimal(subtotal), total: new Prisma.Decimal(Math.max(0, total)) },
  });
}

export async function deleteOrder(organizationId: string, orderId: string) {
  const result = await prisma.order.deleteMany({ where: { id: orderId, organizationId } });
  if (result.count === 0) throw new NotFoundError('Order');
}

// --- parcels ---------------------------------------------------------------

export interface ListParcelsParams {
  page: number;
  pageSize: number;
  status?: ParcelStatus;
  search?: string;
}

export async function listParcels(organizationId: string, params: ListParcelsParams) {
  const where: Prisma.ParcelWhereInput = { organizationId };
  if (params.status) where.status = params.status;
  if (params.search) {
    where.OR = [
      { trackingNumber: { contains: params.search, mode: 'insensitive' } },
      { recipientName: { contains: params.search, mode: 'insensitive' } },
      { recipientPhone: { contains: params.search, mode: 'insensitive' } },
      { courier: { contains: params.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.parcel.findMany({
      where,
      include: { order: { select: { id: true, orderNumber: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.parcel.count({ where }),
  ]);

  return { items, total };
}

export async function getParcel(organizationId: string, parcelId: string) {
  const parcel = await prisma.parcel.findFirst({
    where: { id: parcelId, organizationId },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          currency: true,
          contact: { select: { id: true, displayName: true } },
        },
      },
    },
  });
  if (!parcel) throw new NotFoundError('Parcel');
  return parcel;
}

export interface ParcelInput {
  orderId?: string | null;
  trackingNumber: string;
  courier: string;
  status?: ParcelStatus;
  recipientName?: string | null;
  recipientPhone?: string | null;
  address?: string | null;
  city?: string | null;
  weightKg?: number | null;
  codAmount?: number | null;
  note?: string | null;
}

export async function createParcel(organizationId: string, input: ParcelInput) {
  if (input.orderId) await assertAllBelongToOrg('order', organizationId, [input.orderId], 'Order');

  return prisma.parcel.create({
    data: {
      organizationId,
      orderId: input.orderId ?? null,
      trackingNumber: input.trackingNumber,
      courier: input.courier,
      status: input.status ?? ParcelStatus.CREATED,
      recipientName: input.recipientName,
      recipientPhone: input.recipientPhone,
      address: input.address,
      city: input.city,
      weightKg: input.weightKg != null ? new Prisma.Decimal(input.weightKg) : null,
      codAmount: input.codAmount != null ? new Prisma.Decimal(input.codAmount) : null,
      note: input.note,
      history: [{ status: input.status ?? ParcelStatus.CREATED, at: new Date().toISOString() }] as never,
    },
    include: { order: { select: { id: true, orderNumber: true } } },
  });
}

export async function updateParcelStatus(
  organizationId: string,
  parcelId: string,
  status: ParcelStatus,
  note?: string,
) {
  const parcel = await prisma.parcel.findFirst({ where: { id: parcelId, organizationId } });
  if (!parcel) throw new NotFoundError('Parcel');

  const history = Array.isArray(parcel.history) ? (parcel.history as unknown[]) : [];
  history.push({ status, at: new Date().toISOString(), note });

  return prisma.parcel.update({
    where: { id: parcelId },
    data: {
      status,
      history: history as never,
      ...(status === ParcelStatus.IN_TRANSIT && !parcel.shippedAt ? { shippedAt: new Date() } : {}),
      ...(status === ParcelStatus.DELIVERED ? { deliveredAt: new Date() } : {}),
    },
    include: { order: { select: { id: true, orderNumber: true } } },
  });
}

export async function updateParcel(
  organizationId: string,
  parcelId: string,
  input: Partial<ParcelInput>,
) {
  const result = await prisma.parcel.updateMany({
    where: { id: parcelId, organizationId },
    data: {
      courier: input.courier,
      recipientName: input.recipientName,
      recipientPhone: input.recipientPhone,
      address: input.address,
      city: input.city,
      note: input.note,
      ...(input.weightKg !== undefined
        ? { weightKg: input.weightKg != null ? new Prisma.Decimal(input.weightKg) : null }
        : {}),
      ...(input.codAmount !== undefined
        ? { codAmount: input.codAmount != null ? new Prisma.Decimal(input.codAmount) : null }
        : {}),
    },
  });
  if (result.count === 0) throw new NotFoundError('Parcel');
  return getParcel(organizationId, parcelId);
}

export async function deleteParcel(organizationId: string, parcelId: string) {
  const result = await prisma.parcel.deleteMany({ where: { id: parcelId, organizationId } });
  if (result.count === 0) throw new NotFoundError('Parcel');
}

export async function salesSummary(organizationId: string) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);

  const [orders, revenue, pending, products, parcelsInTransit] = await Promise.all([
    prisma.order.count({ where: { organizationId, placedAt: { gte: since } } }),
    prisma.order.aggregate({
      where: { organizationId, placedAt: { gte: since }, status: { notIn: [OrderStatus.CANCELLED, OrderStatus.REFUNDED] } },
      _sum: { total: true },
    }),
    prisma.order.count({ where: { organizationId, status: OrderStatus.PENDING } }),
    prisma.product.count({ where: { organizationId, isActive: true } }),
    prisma.parcel.count({
      where: { organizationId, status: { in: [ParcelStatus.IN_TRANSIT, ParcelStatus.OUT_FOR_DELIVERY] } },
    }),
  ]);

  return {
    orders30d: orders,
    revenue30d: Number(revenue._sum.total ?? 0),
    pendingOrders: pending,
    activeProducts: products,
    parcelsInTransit,
  };
}
