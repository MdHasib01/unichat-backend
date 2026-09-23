/* eslint-disable no-console */
import 'dotenv/config';
import {
  AutomationActionType,
  AutomationTriggerType,
  CallDirection,
  CallStatus,
  ConversationStatus,
  IntegrationProvider,
  IntegrationStatus,
  KnowledgeDocumentStatus,
  KnowledgeSourceType,
  MemberRole,
  MemberStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  OrderStatus,
  ParcelStatus,
  PaymentStatus,
  Platform,
  Prisma,
  PrismaClient,
  SenderType,
  SocialAccountType,
  TemplateCategory,
} from '@prisma/client';
import argon2 from 'argon2';
import { ALL_PERMISSIONS, PERMISSION_DESCRIPTIONS, ROLE_PERMISSIONS } from '../src/config/permissions';
import { chunkText, lexicalEmbedding } from '../src/ai/rag/embedding';
import { DEFAULT_BUSINESS_HOURS } from '../src/utils/businessHours';

const prisma = new PrismaClient();

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'Unichat2025!';

async function hash(password: string) {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

/** The RBAC catalogue is data so it can be inspected and reported on. */
async function seedPermissions() {
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, description: PERMISSION_DESCRIPTIONS[key] },
      update: { description: PERMISSION_DESCRIPTIONS[key] },
    });
  }

  const permissions = await prisma.permission.findMany();
  const byKey = new Map(permissions.map((p) => [p.key, p.id]));

  for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
    for (const key of keys) {
      const permissionId = byKey.get(key);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { role_permissionId: { role: role as MemberRole, permissionId } },
        create: { role: role as MemberRole, permissionId },
        update: {},
      });
    }
  }

  console.log(`  permissions: ${permissions.length} keys across 4 roles`);
}

interface SeedOrgOptions {
  name: string;
  slug: string;
  description: string;
  industry: string;
  website: string;
  currency: string;
  timezone: string;
  owner: { email: string; firstName: string; lastName: string };
  agents: Array<{ email: string; firstName: string; lastName: string; role: MemberRole }>;
  /** Set false for the second tenant to prove isolation with distinct data. */
  rich: boolean;
}

async function seedOrganization(options: SeedOrgOptions) {
  const passwordHash = await hash(DEMO_PASSWORD);

  const owner = await prisma.user.upsert({
    where: { email: options.owner.email },
    create: {
      email: options.owner.email,
      passwordHash,
      firstName: options.owner.firstName,
      lastName: options.owner.lastName,
      emailVerifiedAt: new Date(),
      timezone: options.timezone,
    },
    update: {},
  });

  const organization = await prisma.organization.upsert({
    where: { slug: options.slug },
    create: {
      name: options.name,
      slug: options.slug,
      description: options.description,
      industry: options.industry,
      website: options.website,
      currency: options.currency,
      timezone: options.timezone,
      businessHours: DEFAULT_BUSINESS_HOURS as unknown as Prisma.InputJsonValue,
      onboardingComplete: true,
      onboardingStep: 10,
    },
    update: {},
  });

  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: owner.id } },
    create: {
      organizationId: organization.id,
      userId: owner.id,
      role: MemberRole.OWNER,
      status: MemberStatus.ACTIVE,
      title: 'Founder',
    },
    update: {},
  });

  const agentUsers = [];
  for (const agent of options.agents) {
    const user = await prisma.user.upsert({
      where: { email: agent.email },
      create: {
        email: agent.email,
        passwordHash,
        firstName: agent.firstName,
        lastName: agent.lastName,
        emailVerifiedAt: new Date(),
        timezone: options.timezone,
      },
      update: {},
    });
    await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
      create: {
        organizationId: organization.id,
        userId: user.id,
        role: agent.role,
        status: MemberStatus.ACTIVE,
      },
      update: {},
    });
    agentUsers.push(user);
  }

  await prisma.subscription.upsert({
    where: { organizationId: organization.id },
    create: {
      organizationId: organization.id,
      plan: 'GROWTH',
      status: 'ACTIVE',
      seats: 10,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    update: {},
  });

  // --- tags ---------------------------------------------------------------

  const tagDefinitions = [
    { name: 'VIP', color: '#f59e0b' },
    { name: 'New customer', color: '#10b981' },
    { name: 'Support', color: '#6366f1' },
    { name: 'Sales', color: '#ec4899' },
    { name: 'Follow up', color: '#0ea5e9' },
  ];
  const tags = [];
  for (const tag of tagDefinitions) {
    tags.push(
      await prisma.tag.upsert({
        where: { organizationId_name: { organizationId: organization.id, name: tag.name } },
        create: { organizationId: organization.id, ...tag },
        update: {},
      }),
    );
  }

  // --- integration + channels (mock mode) ---------------------------------

  const integration = await prisma.integration.upsert({
    where: {
      organizationId_provider: { organizationId: organization.id, provider: IntegrationProvider.META },
    },
    create: {
      organizationId: organization.id,
      provider: IntegrationProvider.META,
      status: IntegrationStatus.CONNECTED,
      displayName: `${options.name} (demo connection)`,
      lastSyncedAt: new Date(),
      metadata: { mock: true } as Prisma.InputJsonValue,
    },
    update: {},
  });

  const channelSuffix = options.slug;

  const pageAccount = await prisma.socialAccount.upsert({
    where: { platform_externalId: { platform: Platform.FACEBOOK, externalId: `page_${channelSuffix}` } },
    create: {
      organizationId: organization.id,
      integrationId: integration.id,
      type: SocialAccountType.FACEBOOK_PAGE,
      platform: Platform.FACEBOOK,
      externalId: `page_${channelSuffix}`,
      name: `${options.name} on Facebook`,
      status: IntegrationStatus.CONNECTED,
      subscribed: true,
    },
    update: {},
  });

  const igAccount = await prisma.socialAccount.upsert({
    where: { platform_externalId: { platform: Platform.INSTAGRAM, externalId: `ig_${channelSuffix}` } },
    create: {
      organizationId: organization.id,
      integrationId: integration.id,
      type: SocialAccountType.INSTAGRAM_ACCOUNT,
      platform: Platform.INSTAGRAM,
      externalId: `ig_${channelSuffix}`,
      parentExternalId: `page_${channelSuffix}`,
      name: `${options.name} on Instagram`,
      username: channelSuffix.replace(/-/g, '.'),
      status: IntegrationStatus.CONNECTED,
      subscribed: true,
    },
    update: {},
  });

  const waAccount = await prisma.socialAccount.upsert({
    where: { platform_externalId: { platform: Platform.WHATSAPP, externalId: `wa_${channelSuffix}` } },
    create: {
      organizationId: organization.id,
      integrationId: integration.id,
      type: SocialAccountType.WHATSAPP_NUMBER,
      platform: Platform.WHATSAPP,
      externalId: `wa_${channelSuffix}`,
      parentExternalId: `waba_${channelSuffix}`,
      name: `${options.name} on WhatsApp`,
      phoneNumber: options.rich ? '+1 555 0100' : '+1 555 0200',
      status: IntegrationStatus.CONNECTED,
      subscribed: true,
    },
    update: {},
  });

  const channels = [pageAccount, igAccount, waAccount];

  // --- contacts + conversations + messages --------------------------------

  const contactSeeds = options.rich
    ? [
        { name: 'Amelia Rahman', platform: Platform.FACEBOOK, city: 'Dhaka' },
        { name: 'Daniel Okoro', platform: Platform.WHATSAPP, city: 'Lagos' },
        { name: 'Priya Nair', platform: Platform.INSTAGRAM, city: 'Mumbai' },
        { name: 'Tom Alvarez', platform: Platform.FACEBOOK, city: 'Madrid' },
        { name: 'Sara Lindqvist', platform: Platform.WHATSAPP, city: 'Stockholm' },
        { name: 'Kenji Watanabe', platform: Platform.INSTAGRAM, city: 'Osaka' },
      ]
    : [
        { name: 'Lucia Ferrari', platform: Platform.FACEBOOK, city: 'Milan' },
        { name: 'Omar Haddad', platform: Platform.WHATSAPP, city: 'Cairo' },
      ];

  const conversationScripts: Array<Array<{ from: 'customer' | 'agent' | 'ai'; text: string }>> = [
    [
      { from: 'customer', text: 'Hi! Do you ship internationally?' },
      { from: 'ai', text: 'Yes — we ship worldwide. International delivery takes 5–9 business days.' },
      { from: 'customer', text: 'Great. How much is shipping to Canada?' },
      { from: 'agent', text: 'Shipping to Canada is a flat $12, free on orders over $150.' },
    ],
    [
      { from: 'customer', text: 'My order still says processing. Can you check it?' },
      { from: 'agent', text: "Of course — I'm looking at it now. It ships tomorrow morning." },
      { from: 'customer', text: 'Perfect, thank you!' },
    ],
    [
      { from: 'customer', text: 'How much is the premium package?' },
      { from: 'ai', text: 'The premium package starts at $149 per month and includes priority support.' },
    ],
    [
      { from: 'customer', text: 'I want to talk to a human please.' },
      { from: 'ai', text: "Sure — I'm connecting you with a member of our team right now." },
    ],
    [{ from: 'customer', text: 'Are you open on Sundays?' }],
    [
      { from: 'customer', text: 'Can I return an item after 20 days?' },
      { from: 'agent', text: 'Yes — our return window is 30 days from delivery for unused items.' },
    ],
  ];

  const contacts = [];
  for (const [index, seed] of contactSeeds.entries()) {
    const externalId = `${seed.platform.toLowerCase()}_${channelSuffix}_${index}`;

    const existing = await prisma.contactIdentifier.findUnique({
      where: {
        organizationId_platform_externalId: {
          organizationId: organization.id,
          platform: seed.platform,
          externalId,
        },
      },
      include: { contact: true },
    });

    const contact =
      existing?.contact ??
      (await prisma.contact.create({
        data: {
          organizationId: organization.id,
          displayName: seed.name,
          firstName: seed.name.split(' ')[0],
          lastName: seed.name.split(' ').slice(1).join(' '),
          email: `${seed.name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
          phone: seed.platform === Platform.WHATSAPP ? `+15550${100 + index}` : null,
          city: seed.city,
          identifiers: {
            create: { organizationId: organization.id, platform: seed.platform, externalId },
          },
        },
      }));

    contacts.push(contact);

    const account = channels.find((c) => c.platform === seed.platform)!;

    const alreadyHasConversation = await prisma.conversation.count({
      where: { organizationId: organization.id, contactId: contact.id },
    });
    if (alreadyHasConversation) continue;

    const script = conversationScripts[index % conversationScripts.length];
    const baseTime = Date.now() - (contactSeeds.length - index) * 3 * 60 * 60 * 1000;

    const conversation = await prisma.conversation.create({
      data: {
        organizationId: organization.id,
        contactId: contact.id,
        socialAccountId: account.id,
        platform: seed.platform,
        externalId,
        status: index % 4 === 3 ? ConversationStatus.RESOLVED : ConversationStatus.OPEN,
        resolvedAt: index % 4 === 3 ? new Date(baseTime + script.length * 60_000) : null,
        messageCount: script.length,
        unreadCount: script[script.length - 1].from === 'customer' ? 1 : 0,
        lastMessageAt: new Date(baseTime + script.length * 60_000),
        lastMessagePreview: script[script.length - 1].text.slice(0, 280),
        lastInboundAt: new Date(baseTime),
        firstResponseSeconds: script.length > 1 ? 45 + index * 30 : null,
      },
    });

    for (const [i, line] of script.entries()) {
      const at = new Date(baseTime + i * 60_000);
      await prisma.message.create({
        data: {
          organizationId: organization.id,
          conversationId: conversation.id,
          platform: seed.platform,
          direction: line.from === 'customer' ? MessageDirection.INBOUND : MessageDirection.OUTBOUND,
          type: MessageType.TEXT,
          status: line.from === 'customer' ? MessageStatus.DELIVERED : MessageStatus.SENT,
          senderType:
            line.from === 'customer'
              ? SenderType.CONTACT
              : line.from === 'ai'
                ? SenderType.AI
                : SenderType.AGENT,
          body: line.text,
          contactId: contact.id,
          userId: line.from === 'agent' ? (agentUsers[i % Math.max(1, agentUsers.length)]?.id ?? owner.id) : null,
          socialAccountId: account.id,
          externalId: `${externalId}_msg_${i}`,
          aiGenerated: line.from === 'ai',
          aiConfidence: line.from === 'ai' ? 0.82 : null,
          createdAt: at,
          deliveredAt: at,
        },
      });
    }

    // Spread assignments and tags so the inbox filters have something to show.
    if (index % 2 === 0 && agentUsers.length) {
      await prisma.conversationAssignment.create({
        data: {
          organizationId: organization.id,
          conversationId: conversation.id,
          assigneeId: agentUsers[index % agentUsers.length].id,
          assignedById: owner.id,
        },
      });
    }
    await prisma.conversationTag.create({
      data: {
        organizationId: organization.id,
        conversationId: conversation.id,
        tagId: tags[index % tags.length].id,
      },
    });
  }

  // --- automations --------------------------------------------------------

  const welcomeExists = await prisma.automation.findFirst({
    where: { organizationId: organization.id, name: 'Welcome new customers' },
  });

  if (!welcomeExists) {
    await prisma.automation.create({
      data: {
        organizationId: organization.id,
        name: 'Welcome new customers',
        description: 'Greets a customer the first time they message, once per person.',
        runOncePerContact: true,
        priority: 10,
        triggers: {
          create: [{ organizationId: organization.id, type: AutomationTriggerType.FIRST_MESSAGE }],
        },
        actions: {
          create: [
            {
              organizationId: organization.id,
              type: AutomationActionType.SEND_MESSAGE,
              order: 0,
              config: {
                message: `Hi {{first_name}}! Thanks for contacting ${options.name}. How can we help you today?`,
              } as Prisma.InputJsonValue,
            },
            {
              organizationId: organization.id,
              type: AutomationActionType.ADD_TAG,
              order: 1,
              config: { tagId: tags[1].id } as Prisma.InputJsonValue,
            },
          ],
        },
      },
    });

    await prisma.automation.create({
      data: {
        organizationId: organization.id,
        name: 'Pricing questions',
        description: 'Routes pricing questions to the assistant and tags them for sales.',
        priority: 20,
        triggers: {
          create: [
            {
              organizationId: organization.id,
              type: AutomationTriggerType.KEYWORD,
              config: {
                keywords: ['price', 'pricing', 'cost', 'how much'],
                matchType: 'any',
              } as Prisma.InputJsonValue,
            },
          ],
        },
        actions: {
          create: [
            {
              organizationId: organization.id,
              type: AutomationActionType.ADD_TAG,
              order: 0,
              config: { tagId: tags[3].id } as Prisma.InputJsonValue,
            },
            { organizationId: organization.id, type: AutomationActionType.TRIGGER_AI, order: 1 },
          ],
        },
      },
    });
  }

  // --- templates ----------------------------------------------------------

  const templates = [
    {
      name: 'Greeting',
      category: TemplateCategory.GREETING,
      body: `Hi {{first_name}}, thanks for reaching out to ${options.name}! How can we help?`,
    },
    {
      name: 'Order status',
      category: TemplateCategory.SUPPORT,
      body: 'Hi {{customer_name}}, your order is on its way and should arrive within 3–5 business days.',
    },
    {
      name: 'Closing',
      category: TemplateCategory.CLOSING,
      body: 'Glad we could help, {{first_name}}! Message us any time.',
    },
  ];

  for (const template of templates) {
    await prisma.messageTemplate.upsert({
      where: { organizationId_name: { organizationId: organization.id, name: template.name } },
      create: {
        organizationId: organization.id,
        ...template,
        variables: Array.from(
          new Set(Array.from(template.body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g), (m) => m[1])),
        ),
      },
      update: {},
    });
  }

  // --- AI assistant + knowledge -------------------------------------------

  await prisma.aIAssistant.upsert({
    where: { organizationId: organization.id },
    create: {
      organizationId: organization.id,
      name: `${options.name} Assistant`,
      autoReplyEnabled: options.rich,
      confidenceThreshold: 0.6,
      systemPrompt: `You are the customer support assistant for ${options.name}. Answer only from the business knowledge provided.`,
    },
    update: {},
  });

  const knowledgeBase = await prisma.aIKnowledgeBase.upsert({
    where: {
      id:
        (
          await prisma.aIKnowledgeBase.findFirst({
            where: { organizationId: organization.id, isDefault: true },
            select: { id: true },
          })
        )?.id ?? 'missing',
    },
    create: { organizationId: organization.id, name: 'Default knowledge base', isDefault: true },
    update: {},
  });

  const knowledgeDocs = options.rich
    ? [
        {
          title: 'Shipping & delivery',
          content: `${options.name} ships worldwide. Domestic orders arrive in 2–4 business days and international orders in 5–9 business days. Shipping is a flat $12 and free on orders over $150. Every order includes tracking, sent by message as soon as the parcel leaves our warehouse.`,
        },
        {
          title: 'Returns & refunds',
          content: `Unused items can be returned within 30 days of delivery for a full refund. Start a return by messaging us with your order number. Refunds are issued to the original payment method within 5 business days of the parcel arriving back with us. Sale items are final and cannot be returned.`,
        },
        {
          title: 'Pricing & packages',
          content: `${options.name} offers three packages. Starter is $49 per month and covers one channel with up to 500 conversations. Growth is $99 per month, covers all three channels and adds automation. Premium starts at $149 per month and adds priority support, unlimited AI replies and a dedicated success manager.`,
        },
        {
          title: 'Opening hours & contact',
          content: `Our team answers messages Monday to Friday, 9:00 to 18:00 (${options.timezone}). Outside those hours the assistant replies and a person follows up the next working morning. You can reach us on Facebook Messenger, Instagram Direct or WhatsApp — all three land in the same inbox.`,
        },
      ]
    : [
        {
          title: 'About us',
          content: `${options.name} is a ${options.industry.toLowerCase()} business. We answer messages Monday to Saturday and ship locally within 2 business days.`,
        },
      ];

  for (const doc of knowledgeDocs) {
    const existing = await prisma.aIKnowledgeDocument.findFirst({
      where: { organizationId: organization.id, title: doc.title },
    });
    if (existing) continue;

    const chunks = chunkText(doc.content);

    // Embeddings are generated with the built-in lexical embedder so the
    // seeded knowledge is searchable without any AI key configured.
    await prisma.aIKnowledgeDocument.create({
      data: {
        organizationId: organization.id,
        knowledgeBaseId: knowledgeBase.id,
        title: doc.title,
        content: doc.content,
        sourceType: KnowledgeSourceType.MANUAL,
        status: KnowledgeDocumentStatus.READY,
        chunkCount: chunks.length,
        tokenCount: Math.ceil(doc.content.length / 4),
        chunks: {
          create: chunks.map((content, chunkIndex) => ({
            organizationId: organization.id,
            chunkIndex,
            content,
            tokenCount: Math.ceil(content.length / 4),
            embedding: lexicalEmbedding(content),
            embeddingModel: 'mock-lexical-256',
          })),
        },
      },
    });
  }

  // --- sales --------------------------------------------------------------

  const productSeeds = options.rich
    ? [
        { name: 'Starter plan', sku: 'PLAN-STARTER', price: 49, category: 'Plans', stock: 999 },
        { name: 'Growth plan', sku: 'PLAN-GROWTH', price: 99, category: 'Plans', stock: 999 },
        { name: 'Premium plan', sku: 'PLAN-PREMIUM', price: 149, category: 'Plans', stock: 999 },
        { name: 'Onboarding workshop', sku: 'SVC-ONBOARD', price: 299, category: 'Services', stock: 20 },
      ]
    : [{ name: 'Signature blend', sku: 'ITEM-001', price: 24.5, category: 'Retail', stock: 80 }];

  const products = [];
  for (const product of productSeeds) {
    products.push(
      await prisma.product.upsert({
        where: { organizationId_sku: { organizationId: organization.id, sku: product.sku } },
        create: {
          organizationId: organization.id,
          name: product.name,
          sku: product.sku,
          price: new Prisma.Decimal(product.price),
          currency: options.currency,
          stock: product.stock,
          category: product.category,
          description: `${product.name} from ${options.name}.`,
        },
        update: {},
      }),
    );
  }

  const existingOrders = await prisma.order.count({ where: { organizationId: organization.id } });
  if (!existingOrders) {
    for (let i = 0; i < (options.rich ? 5 : 2); i += 1) {
      const product = products[i % products.length];
      const quantity = 1 + (i % 3);
      const unit = Number(product.price);
      const subtotal = unit * quantity;
      const shipping = 12;

      const order = await prisma.order.create({
        data: {
          organizationId: organization.id,
          orderNumber: `UC-${String(i + 1).padStart(6, '0')}`,
          contactId: contacts[i % contacts.length]?.id,
          status: [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.SHIPPED, OrderStatus.DELIVERED][i % 4],
          paymentStatus: i % 3 === 0 ? PaymentStatus.UNPAID : PaymentStatus.PAID,
          currency: options.currency,
          subtotal: new Prisma.Decimal(subtotal),
          shippingFee: new Prisma.Decimal(shipping),
          total: new Prisma.Decimal(subtotal + shipping),
          customerName: contacts[i % contacts.length]?.displayName,
          customerPhone: contacts[i % contacts.length]?.phone,
          city: 'Springfield',
          shippingAddress: `${100 + i} Market Street`,
          placedAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
          items: {
            create: [
              {
                organizationId: organization.id,
                productId: product.id,
                name: product.name,
                sku: product.sku,
                quantity,
                unitPrice: new Prisma.Decimal(unit),
                total: new Prisma.Decimal(subtotal),
              },
            ],
          },
        },
      });

      if (i % 2 === 0) {
        await prisma.parcel.create({
          data: {
            organizationId: organization.id,
            orderId: order.id,
            trackingNumber: `TRK${String(1000 + i)}${channelSuffix.slice(0, 3).toUpperCase()}`,
            courier: ['SwiftPost', 'GlobalEx', 'CityRun'][i % 3],
            status: [ParcelStatus.IN_TRANSIT, ParcelStatus.DELIVERED, ParcelStatus.CREATED][i % 3],
            recipientName: order.customerName,
            recipientPhone: order.customerPhone,
            address: order.shippingAddress,
            city: order.city,
            weightKg: new Prisma.Decimal(1.2),
            history: [{ status: 'CREATED', at: new Date().toISOString() }] as Prisma.InputJsonValue,
          },
        });
      }
    }
  }

  // --- calls --------------------------------------------------------------

  const existingCalls = await prisma.callRecord.count({ where: { organizationId: organization.id } });
  if (!existingCalls && options.rich) {
    for (let i = 0; i < 4; i += 1) {
      await prisma.callRecord.create({
        data: {
          organizationId: organization.id,
          contactId: contacts[i % contacts.length]?.id,
          direction: i % 2 === 0 ? CallDirection.INBOUND : CallDirection.OUTBOUND,
          status: i === 3 ? CallStatus.MISSED : CallStatus.COMPLETED,
          fromNumber: i % 2 === 0 ? '+15550199' : '+15550100',
          toNumber: i % 2 === 0 ? '+15550100' : '+15550199',
          durationSeconds: i === 3 ? 0 : 120 + i * 45,
          provider: 'demo-telephony',
          // Recording metadata only; no audio file is fabricated.
          summary: i === 3 ? null : 'Customer asked about delivery timing and upgrade options.',
          startedAt: new Date(Date.now() - (i + 1) * 6 * 60 * 60 * 1000),
          endedAt: new Date(Date.now() - (i + 1) * 6 * 60 * 60 * 1000 + 180_000),
        },
      });
    }
  }

  console.log(`  ${options.name}: owner ${options.owner.email}, ${contacts.length} contacts`);
  return organization;
}

async function main() {
  console.log('Seeding Unichat…');

  await seedPermissions();

  await seedOrganization({
    name: 'Demo Business',
    slug: 'demo-business',
    description: 'A demo workspace showing Unichat with real conversations, automation and AI knowledge.',
    industry: 'Retail & e-commerce',
    website: 'https://demo-business.example.com',
    currency: 'USD',
    timezone: 'UTC',
    owner: { email: 'owner@demo.unichat.app', firstName: 'Dana', lastName: 'Owens' },
    agents: [
      { email: 'admin@demo.unichat.app', firstName: 'Sam', lastName: 'Taylor', role: MemberRole.ADMIN },
      { email: 'manager@demo.unichat.app', firstName: 'Morgan', lastName: 'Lee', role: MemberRole.MANAGER },
      { email: 'agent@demo.unichat.app', firstName: 'Alex', lastName: 'Rivera', role: MemberRole.AGENT },
    ],
    rich: true,
  });

  // A second tenant exists so isolation is demonstrable, not just asserted.
  await seedOrganization({
    name: 'Northside Coffee',
    slug: 'northside-coffee',
    description: 'A second workspace that proves tenant isolation — its data never appears in Demo Business.',
    industry: 'Food & beverage',
    website: 'https://northside.example.com',
    currency: 'EUR',
    timezone: 'Europe/Berlin',
    owner: { email: 'owner@northside.unichat.app', firstName: 'Nora', lastName: 'Schmidt' },
    agents: [
      { email: 'agent@northside.unichat.app', firstName: 'Felix', lastName: 'Bauer', role: MemberRole.AGENT },
    ],
    rich: false,
  });

  console.log('\nSeed complete. Sign in with:');
  console.log(`  owner@demo.unichat.app       / ${DEMO_PASSWORD}   (OWNER, Demo Business)`);
  console.log(`  admin@demo.unichat.app       / ${DEMO_PASSWORD}   (ADMIN)`);
  console.log(`  manager@demo.unichat.app     / ${DEMO_PASSWORD}   (MANAGER)`);
  console.log(`  agent@demo.unichat.app       / ${DEMO_PASSWORD}   (AGENT)`);
  console.log(`  owner@northside.unichat.app  / ${DEMO_PASSWORD}   (OWNER, Northside Coffee)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
