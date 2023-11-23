import { streamToBuffer } from '@/utils';
import { DefaultAzureCredential } from '@azure/identity';
import {
  AccountSASResourceTypes,
  AccountSASServices,
  BlobItem,
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  SASProtocol,
  StoragePipelineOptions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import * as fs from 'fs/promises';
import * as mimetics from 'mimetics';
import * as path from 'path';
import {
  PluginCreateOptions,
  PublishResult,
  PublisherPlugin,
  WorkingDirectoryInfo,
} from 'reg-suit-interface';
import {
  AbstractPublisher,
  FileItem,
  ObjectListResult,
  RemoteFileItem,
} from 'reg-suit-util';

export interface PluginConfig {
  url: string;
  containerName: string;
  useDefaultCredential: boolean;
  accountName?: string;
  accountKey?: string;
  sasExpiryHour?: number;
  options?: StoragePipelineOptions;
  pattern?: string;
  pathPrefix?: string;
}

export class AbsPublisherPlugin
  extends AbstractPublisher
  implements PublisherPlugin<PluginConfig>
{
  name = 'reg-publish-azure-blob-storage-plugin';

  private options!: PluginCreateOptions<PluginConfig>;
  private pluginConfig!: PluginConfig;
  private blobServiceClient: BlobServiceClient;
  private containerClient!: ContainerClient;

  init(config: PluginCreateOptions<PluginConfig>): void {
    this.noEmit = config.noEmit;
    this.logger = config.logger;
    this.options = config;
    this.pluginConfig = config.options;
    const credential = this.pluginConfig.useDefaultCredential
      ? new DefaultAzureCredential()
      : this.createSharedKeyCredential();
    this.blobServiceClient = new BlobServiceClient(
      this.pluginConfig.url,
      credential,
      this.pluginConfig.options
    );
    this.containerClient = this.blobServiceClient.getContainerClient(
      this.getBucketName()
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async fetch(key: string): Promise<any> {
    return this.fetchInternal(key);
  }

  async publish(key: string): Promise<PublishResult> {
    const { indexFile } = await this.publishInternal(key);
    if (this.pluginConfig.sasExpiryHour !== undefined) {
      await this.addAuthScript(indexFile, key);
    }

    const reportUrl =
      indexFile &&
      `${this.pluginConfig.url}/${
        this.pluginConfig.containerName
      }/${this.resolveInBucket(key)}/${indexFile.path}${
        (await this.createAccountSas()) ?? ''
      }`;

    return { reportUrl };
  }

  private async addAuthScript(indexFile: FileItem, key: string) {
    const content = (await fs.readFile(indexFile.absPath)).toString();
    const insertPos = content.indexOf('<body>') + '<body>'.length;
    const additionalScript = `
  <script lang="text/javascript">
    ${await fs.readFile(path.join(__dirname, 'helpers', 'sas', 'sasHelper.js'))}
  </script>`;
    const modifiedContent =
      content.slice(0, insertPos) + additionalScript + content.slice(insertPos);
    this.logger.verbose(`Modified index.html:\n${modifiedContent}`);
    await fs.writeFile(indexFile.absPath, modifiedContent);
    const data = Buffer.from(modifiedContent);
    await this.containerClient.uploadBlockBlob(
      `${key}/${indexFile.path}`,
      data,
      data.length,
      {
        blobHTTPHeaders: {
          blobContentType: indexFile.mimeType,
        },
      }
    );
    const serviceWorkerFile = await fs.readFile(
      path.join(__dirname, 'helpers', 'sas', 'appendSas.js')
    );
    await this.containerClient.uploadBlockBlob(
      `${key}/appendSas.js`,
      serviceWorkerFile,
      serviceWorkerFile.length,
      {
        blobHTTPHeaders: {
          blobContentType: 'text/javascript',
        },
      }
    );
    this.logger.verbose(
      `Uploaded from ${indexFile.absPath} to ${key}/${indexFile.path}`
    );
  }

  protected async uploadItem(key: string, item: FileItem): Promise<FileItem> {
    const data = await fs.readFile(item.absPath);
    const fileInfo = await mimetics.parse(data);

    await this.containerClient.uploadBlockBlob(
      `${key}/${item.path}`,
      data,
      data.length,
      {
        blobHTTPHeaders: {
          blobContentType: fileInfo.mime,
        },
      }
    );
    this.logger.verbose(`Uploaded from ${item.absPath} to ${key}/${item.path}`);
    return item;
  }

  protected async downloadItem(
    remoteItem: RemoteFileItem,
    item: FileItem
  ): Promise<FileItem> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(
      remoteItem.remotePath
    );
    const blobDownloadResponse = await blockBlobClient.download();
    const content = await streamToBuffer(
      blobDownloadResponse.readableStreamBody
    );
    const dirName = path.dirname(item.absPath);
    await fs.mkdir(dirName, { recursive: true });
    await fs.writeFile(item.absPath, content);
    this.logger.verbose(
      `Downloaded from ${remoteItem.remotePath} to ${item.absPath}`
    );
    return item;
  }

  protected async listItems(
    lastKey: string,
    prefix: string
  ): Promise<ObjectListResult> {
    const iterator = this.containerClient.listBlobsFlat({ prefix }).byPage({
      maxPageSize: 1000,
      continuationToken: lastKey === '' ? undefined : lastKey,
    });
    const response = await iterator.next();
    const nextMarker = response.value.continuationToken;
    const files: BlobItem[] | undefined | null =
      response.value.segment.blobItems;
    return {
      isTruncated: response.done,
      contents: !files
        ? []
        : files
            .filter(
              (item) =>
                !('ResourceType' in item.properties) ||
                item.properties.ResourceType === 'file'
            )
            .map((item) => ({
              key: item.name,
            })),
      nextMarker,
    };
  }
  protected getWorkingDirs(): WorkingDirectoryInfo {
    return this.options.workingDirs;
  }
  protected getLocalGlobPattern(): string {
    return this.pluginConfig.pattern;
  }
  protected getBucketName(): string {
    return this.pluginConfig.containerName;
  }
  protected getBucketRootDir(): string | undefined {
    return this.pluginConfig.pathPrefix;
  }

  private createSharedKeyCredential(): StorageSharedKeyCredential | undefined {
    const { accountName, accountKey } = this.pluginConfig;
    if (accountName === undefined || accountKey === undefined) {
      return;
    }
    return new StorageSharedKeyCredential(accountName, accountKey);
  }

  private async createAccountSas(): Promise<string | undefined> {
    const { accountName, useDefaultCredential, containerName, sasExpiryHour } =
      this.pluginConfig;
    if (
      accountName === undefined ||
      containerName === undefined ||
      sasExpiryHour === undefined
    ) {
      return;
    }

    const sasOptions = {
      services: AccountSASServices.parse('b').toString(),
      resourceTypes: AccountSASResourceTypes.parse('co').toString(),
      permissions: BlobSASPermissions.parse('r'),
      protocol: SASProtocol.Https,
      startsOn: new Date(),
      expiresOn: new Date(
        new Date().valueOf() + sasExpiryHour * 60 * 60 * 1000
      ),
      containerName,
    };

    if (useDefaultCredential) {
      return generateBlobSASQueryParameters(
        sasOptions,
        await this.blobServiceClient.getUserDelegationKey(
          sasOptions.startsOn,
          sasOptions.expiresOn
        ),
        accountName
      ).toString();
    }

    return generateBlobSASQueryParameters(
      sasOptions,
      this.createSharedKeyCredential()
    ).toString();
  }
}
