import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../utils/response';
import {
  createOrder,
  createParcel,
  createProduct,
  deleteOrder,
  deleteParcel,
  deleteProduct,
  getOrder,
  getParcel,
  getProduct,
  listOrders,
  listParcels,
  listProducts,
  salesSummary,
  updateOrder,
  updateParcel,
  updateParcelStatus,
  updateProduct,
} from '../services/sales.service';
import { auditFromRequest } from '../services/audit.service';
import { notificationQueue } from '../queues';

// --- products --------------------------------------------------------------

export async function listProductsController(req: Request, res: Response) {
  const query = req.query as unknown as {
    page: number;
    pageSize: number;
    search?: string;
    category?: string;
    isActive?: boolean;
  };
  const { items, total } = await listProducts(req.tenant!.organizationId, query);
  return paginated(res, items, query.page, query.pageSize, total);
}

export async function getProductController(req: Request, res: Response) {
  return ok(res, await getProduct(req.tenant!.organizationId, req.params.id));
}

export async function createProductController(req: Request, res: Response) {
  const product = await createProduct(req.tenant!.organizationId, req.body);
  await auditFromRequest(req, 'product.created', { entityType: 'Product', entityId: product.id });
  return created(res, product, 'Product created');
}

export async function updateProductController(req: Request, res: Response) {
  const product = await updateProduct(req.tenant!.organizationId, req.params.id, req.body);
  return ok(res, product, 'Product updated');
}

export async function deleteProductController(req: Request, res: Response) {
  await deleteProduct(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'product.deleted', { entityType: 'Product', entityId: req.params.id });
  return noContent(res);
}

// --- orders ----------------------------------------------------------------

export async function listOrdersController(req: Request, res: Response) {
  const query = req.query as unknown as {
    page: number;
    pageSize: number;
    search?: string;
    status?: never;
    paymentStatus?: never;
    contactId?: string;
  };
  const { items, total } = await listOrders(req.tenant!.organizationId, query);
  return paginated(res, items, query.page, query.pageSize, total);
}

export async function getOrderController(req: Request, res: Response) {
  return ok(res, await getOrder(req.tenant!.organizationId, req.params.id));
}

export async function createOrderController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  const order = await createOrder(organizationId, req.body);

  await notificationQueue().add('notify', {
    organizationId,
    type: 'ORDER_CREATED',
    title: `New order ${order.orderNumber}`,
    body: `${order.items.length} item(s) · ${order.total.toString()} ${order.currency}`,
    link: `/sales/orders/${order.id}`,
  });

  await auditFromRequest(req, 'order.created', { entityType: 'Order', entityId: order.id });
  return created(res, order, `Order ${order.orderNumber} created`);
}

export async function updateOrderController(req: Request, res: Response) {
  const order = await updateOrder(req.tenant!.organizationId, req.params.id, req.body);
  await auditFromRequest(req, 'order.updated', {
    entityType: 'Order',
    entityId: req.params.id,
    metadata: req.body,
  });
  return ok(res, order, 'Order updated');
}

export async function deleteOrderController(req: Request, res: Response) {
  await deleteOrder(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'order.deleted', { entityType: 'Order', entityId: req.params.id });
  return noContent(res);
}

// --- parcels ---------------------------------------------------------------

export async function listParcelsController(req: Request, res: Response) {
  const query = req.query as unknown as {
    page: number;
    pageSize: number;
    search?: string;
    status?: never;
  };
  const { items, total } = await listParcels(req.tenant!.organizationId, query);
  return paginated(res, items, query.page, query.pageSize, total);
}

export async function getParcelController(req: Request, res: Response) {
  return ok(res, await getParcel(req.tenant!.organizationId, req.params.id));
}

export async function createParcelController(req: Request, res: Response) {
  const parcel = await createParcel(req.tenant!.organizationId, req.body);
  await auditFromRequest(req, 'parcel.created', { entityType: 'Parcel', entityId: parcel.id });
  return created(res, parcel, 'Parcel created');
}

export async function updateParcelController(req: Request, res: Response) {
  const parcel = await updateParcel(req.tenant!.organizationId, req.params.id, req.body);
  return ok(res, parcel, 'Parcel updated');
}

export async function updateParcelStatusController(req: Request, res: Response) {
  const parcel = await updateParcelStatus(
    req.tenant!.organizationId,
    req.params.id,
    req.body.status,
    req.body.note,
  );
  await auditFromRequest(req, 'parcel.status_changed', {
    entityType: 'Parcel',
    entityId: req.params.id,
    metadata: { status: req.body.status },
  });
  return ok(res, parcel, 'Parcel status updated');
}

export async function deleteParcelController(req: Request, res: Response) {
  await deleteParcel(req.tenant!.organizationId, req.params.id);
  return noContent(res);
}

export async function salesSummaryController(req: Request, res: Response) {
  return ok(res, await salesSummary(req.tenant!.organizationId));
}
