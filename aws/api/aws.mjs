// Where the service keeps things on AWS: items in a DynamoDB table, files in an S3 bucket, and
// sign-ins in a Cognito user pool. The names come from the stack (see ../template.yml).
import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { TABLE, FILES, POOL } = process.env;
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const URL_SECONDS = 300;

export const db = {
  get: async (pk, sk) => (await doc.send(new GetCommand({ TableName: TABLE, Key: { pk, sk }, ConsistentRead: true }))).Item,
  put: (Item) => doc.send(new PutCommand({ TableName: TABLE, Item })),
  del: (pk, sk) => doc.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk } })),
  async query(pk, { prefix = '', cursor } = {}) {
    const page = await doc.send(new QueryCommand({
      TableName: TABLE, ConsistentRead: true,
      // The table will not be asked for keys beginning with nothing; no prefix means every item of the pk.
      KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :prefix)' : 'pk = :pk',
      ExpressionAttributeValues: prefix ? { ':pk': pk, ':prefix': prefix } : { ':pk': pk },
      ExclusiveStartKey: cursor && JSON.parse(Buffer.from(cursor, 'base64url').toString()),
    }));
    return { items: page.Items, next: page.LastEvaluatedKey && Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString('base64url') };
  },
  async bump(pk, sk, field) {
    const { Attributes } = await doc.send(new UpdateCommand({
      TableName: TABLE, Key: { pk, sk }, UpdateExpression: 'ADD #f :one',
      ExpressionAttributeNames: { '#f': field }, ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'UPDATED_NEW',
    }));
    return Attributes[field];
  },
  // Twenty-five at a time is the most the table takes; any it could not take yet are sent again.
  async putAll(items) {
    for (let i = 0; i < items.length; i += 25) {
      let waiting = { [TABLE]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
      for (let tries = 0; waiting[TABLE]?.length; tries++) {
        if (tries > 8) throw new Error('The table would not take the rows.');
        if (tries) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** tries));
        waiting = (await doc.send(new BatchWriteCommand({ RequestItems: waiting }))).UnprocessedItems ?? {};
      }
    }
  },
};

export const files = {
  // The address accepts exactly this kind and size of file, so nothing else can be put there with it.
  putUrl: (Key, ContentType, ContentLength) =>
    getSignedUrl(s3, new PutObjectCommand({ Bucket: FILES, Key, ContentType, ContentLength }), { expiresIn: URL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) }),
  getUrl: (Key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: FILES, Key }), { expiresIn: URL_SECONDS }),
  async removeAll(Prefix) {
    let ContinuationToken;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: FILES, Prefix, ContinuationToken }));
      if (page.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: FILES, Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) } }));
      ContinuationToken = page.NextContinuationToken;
    } while (ContinuationToken);
  },
};

export const users = {
  remove: (Username) => new CognitoIdentityProviderClient({}).send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username })),
};
