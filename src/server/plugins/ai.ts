import { _ } from '@/lib/lodash';
import "pdf-parse";
import { ChatOpenAI, ClientOptions, OpenAIEmbeddings, } from "@langchain/openai";
import path from 'path';
import type { Document } from "@langchain/core/documents";
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { StringOutputParser } from '@langchain/core/output_parsers';
import { OpenAIWhisperAudio } from "@langchain/community/document_loaders/fs/openai_whisper_audio";
import { prisma } from '../prisma';
import { FAISS_PATH, UPLOAD_FILE_PATH } from '@/lib/constant';
import { AiModelFactory } from './ai/aiModelFactory';
import { ProgressResult } from './memos';
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { UnstructuredLoader } from "@langchain/community/document_loaders/fs/unstructured";
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import { BaseDocumentLoader } from '@langchain/core/document_loaders/base';
import { FileService } from './utils';

//https://js.langchain.com/docs/introduction/
//https://smith.langchain.com/onboarding
//https://js.langchain.com/docs/tutorials/qa_chat_history
const FaissStorePath = path.join(process.cwd(), FAISS_PATH);

export class AiService {
  static async loadFileContent(filePath: string): Promise<string> {
    try {
      let loader: BaseDocumentLoader;
      switch (true) {
        case filePath.endsWith('.pdf'):
          console.log('load pdf')
          loader = new PDFLoader(filePath);
          break;
        case filePath.endsWith('.docx') || filePath.endsWith('.doc'):
          console.log('load docx')
          loader = new DocxLoader(filePath);
          break;
        case filePath.endsWith('.txt'):
          console.log('load txt')
          loader = new TextLoader(filePath);
          break;
        // case filePath.endsWith('.csv'):
        //   console.log('load csv')
        //   loader = new CSVLoader(filePath);
        //   break;
        default:
          loader = new UnstructuredLoader(filePath);
      }
      const docs = await loader.load();
      return docs.map(doc => doc.pageContent).join('\n');
    } catch (error) {
      console.error('File loading error:', error);
      throw new Error(`can not load file: ${filePath}`);
    }
  }

  static async embeddingDeleteAll(id: number, VectorStore: FaissStore) {
    for (const index of new Array(9999).keys()) {
      console.log('delete', `${id}-${index}`)
      try {
        await VectorStore.delete({ ids: [`${id}-${index}`] })
        await VectorStore.save(FaissStorePath)
      } catch (error) {
        break;
      }
    }
  }

  static async embeddingDeleteAllAttachments(filePath: string, VectorStore: FaissStore) {
    for (const index of new Array(9999).keys()) {
      try {
        await VectorStore.delete({ ids: [`${filePath}-${index}`] })
        await VectorStore.save(FaissStorePath)
      } catch (error) {
        break;
      }
    }
  }

  static async embeddingUpsert({ id, content, type }: { id: number, content: string, type: 'update' | 'insert' }) {
    try {
      const { VectorStore, MarkdownSplitter } = await AiModelFactory.GetProvider()
      const chunks = await MarkdownSplitter.splitText(content);

      if (type == 'update') {
        await AiService.embeddingDeleteAll(id, VectorStore)
      }

      const documents: Document[] = chunks.map((chunk, index) => {
        return {
          pageContent: chunk,
          metadata: { noteId: id, uniqDocId: `${id}-${index}` },
        }
      })
      try {
        await prisma.notes.update({
          where: { id },
          data: {
            metadata: {
              isIndexed: true
            }
          }
        })
      } catch (error) {
        console.log(error)
      }
      const BATCH_SIZE = 5;
      for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = documents.slice(i, i + BATCH_SIZE);
        const batchIds = batch.map(doc => doc.metadata.uniqDocId);
        await VectorStore.addDocuments(batch, { ids: batchIds });
      }
      await VectorStore.save(FaissStorePath)
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  //api/file/123.pdf
  static async embeddingInsertAttachments({ id, filePath }: { id: number, filePath: string }) {
    try {
      const note = await prisma.notes.findUnique({ where: { id } })
      //@ts-ignore
      if (note?.metadata?.isAttachmentsIndexed) {
        return { ok: true, msg: 'already indexed' }
      }
      const absolutePath = await FileService.getFile(filePath)
      const content = await AiService.loadFileContent(absolutePath);
      console.log('content', content)
      const { VectorStore, TokenTextSplitter } = await AiModelFactory.GetProvider()
      const chunks = await TokenTextSplitter.splitText(content);
      console.log('chunks', chunks)
      const documents: Document[] = chunks.map((chunk, index) => {
        return {
          pageContent: chunk,
          metadata: {
            noteId: id,
            uniqDocId: `${filePath}-${index}`
          },
        }
      })

      try {
        await prisma.notes.update({
          where: { id },
          data: {
            metadata: {
              isAttachmentsIndexed: true
            }
          }
        })
      } catch (error) {
        console.log(error)
      }

      const BATCH_SIZE = 5;
      for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = documents.slice(i, i + BATCH_SIZE);
        const batchIds = batch.map(doc => doc.metadata.uniqDocId);
        await VectorStore.addDocuments(batch, { ids: batchIds });
      }

      await VectorStore.save(FaissStorePath)
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }



  static async embeddingDelete({ id }: { id: number }) {
    const { VectorStore } = await AiModelFactory.GetProvider()
    await AiService.embeddingDeleteAll(id, VectorStore)
    const attachments = await prisma.attachments.findMany({ where: { noteId: id } })
    for (const attachment of attachments) {
      console.log({ deletPath: attachment.path })
      await AiService.embeddingDeleteAllAttachments(attachment.path, VectorStore)
    }
    return { ok: true }
  }

  static async similaritySearch({ question }: { question: string }) {
    const { VectorStore } = await AiModelFactory.GetProvider()
    const result = await VectorStore.similaritySearch(question, 2);
    return result
  }

  static async *rebuildEmbeddingIndex(): AsyncGenerator<ProgressResult & { progress?: { current: number, total: number } }, void, unknown> {
    const notes = await prisma.notes.findMany();
    const total = notes.length;
    const BATCH_SIZE = 5;

    console.log({ total })
    let current = 0;

    for (let i = 0; i < notes.length; i += BATCH_SIZE) {
      const noteBatch = notes.slice(i, i + BATCH_SIZE);
      for (const note of noteBatch) {
        current++;
        try {
          //@ts-ignore
          if (note.metadata?.isIndexed) {
            console.log('skip note:', note.id);
            yield {
              type: 'skip' as const,
              content: note.content.slice(0, 30),
              progress: { current, total }
            };
            continue;
          }
          await AiService.embeddingUpsert({
            id: note?.id,
            content: note?.content,
            type: 'insert' as const
          });
          //@ts-ignore
          if (!note.metadata?.isAttachmentsIndexed) {
            //@ts-ignore
            for (const attachment of note.attachments) {
              await AiService.embeddingInsertAttachments({
                id: note?.id,
                filePath: attachment.path
              });
            }
          }
          yield {
            type: 'success' as const,
            content: note?.content.slice(0, 30) ?? '',
            progress: { current, total }
          };
        } catch (error) {
          console.error('rebuild index error->', error);
          yield {
            type: 'error' as const,
            content: note.content.slice(0, 30),
            error,
            progress: { current, total }
          };
        }
      }
    }
  }

  static getQAPrompt() {
    const systemPrompt =
      "You are a versatile AI assistant who can: \n" +
      "1. Answer questions and explain concepts\n" +
      "2. Provide suggestions and analysis\n" +
      "3. Help with planning and organizing ideas\n" +
      "4. Assist with content creation and editing\n" +
      "5. Perform basic calculations and reasoning\n\n" +
      "Use the following context to assist with your responses: \n" +
      "{context}\n\n" +
      "If a request is beyond your capabilities, please be honest about it.\n" +
      "Always respond in the user's language.\n" +
      "Maintain a friendly and professional conversational tone.";

    const qaPrompt = ChatPromptTemplate.fromMessages(
      [
        ["system", systemPrompt],
        new MessagesPlaceholder("chat_history"),
        ["human", "{input}"]
      ]
    )

    return qaPrompt
  }

  static getChatHistory({ conversations }: { conversations: { role: string, content: string }[] }) {
    const conversationMessage = conversations.map(i => {
      if (i.role == 'user') {
        return new HumanMessage(i.content)
      }
      return new AIMessage(i.content)
    })
    conversationMessage.pop()
    return conversationMessage
  }

  static async completions({ question, conversations }: { question: string, conversations: { role: string, content: string }[] }) {
    try {
      const { LLM } = await AiModelFactory.GetProvider()
      let searchRes = await AiService.similaritySearch({ question })
      console.log('searchRes', searchRes)
      let notes: any[] = []
      if (searchRes && searchRes.length != 0) {
        notes = await prisma.notes.findMany({
          where: {
            id: {
              in: _.uniqWith(searchRes.map(i => i.metadata?.noteId)).filter(i => !!i) as number[]
            }
          },
          include: {
            attachments: true
          }
        })
      }
      notes = notes?.map(i => { return { ...i, index: searchRes.findIndex(t => t.metadata.noteId == i.id) } }) ?? []
      //@ts-ignore
      notes.sort((a, b) => a.index! - b.index!)
      const chat_history = AiService.getChatHistory({ conversations })
      const qaPrompt = AiService.getQAPrompt()
      const qaChain = qaPrompt.pipe(LLM).pipe(new StringOutputParser())
      const result = await qaChain.stream({
        chat_history,
        input: question,
        context: searchRes[0]?.pageContent
      })
      return { result, notes }
    } catch (error) {
      console.log(error)
      throw new Error(error)
    }
  }


  static getWritingPrompt(type: 'expand' | 'polish' | 'custom', content?: string) {
   const systemPrompts = {
      expand: `You are a professional writing assistant. Your task is to expand and enrich the given text content:
      1. Detect and use the same language as the input content
      2. Add more details and descriptions
      3. Expand arguments and examples
      4. Include relevant background information
      5. Maintain consistency with the original tone and style
      
      Original content:
      {content}
      
      Important:
      - Respond in the SAME LANGUAGE as the input content
      - Use Markdown format
      - Replace all spaces with &#x20;
      - Use two line breaks between paragraphs
      - Ensure line breaks between list items`,
      
      polish: `You are a professional text editor. Your task is to polish and optimize the given text:
      1. Detect and use the same language as the input content
      2. Improve word choice and expressions
      3. Optimize sentence structure
      4. Maintain the original core meaning
      5. Ensure the text flows naturally
      
      Original content:
      {content}
      
      Important:
      - Respond in the SAME LANGUAGE as the input content
      - Use Markdown format
      - Replace all spaces with &#x20;
      - Use two line breaks between paragraphs
      - Ensure line breaks between list items`,
  
      custom: `You are a professional writing assistant. Your task is to:
      1. Detect and use the same language as the input content
      2. Create content according to user requirements
      3. Maintain professional writing standards
      4. Follow technical documentation best practices when needed
      
      Important:
      - Respond in the SAME LANGUAGE as the input content
      - Use Markdown format
      - Replace all spaces with &#x20;
      - Use two line breaks between paragraphs
      - Ensure line breaks between list items
      - Use appropriate Markdown elements (code blocks, tables, lists, etc.)`
    };
  
    const writingPrompt = ChatPromptTemplate.fromMessages([
      ["system", systemPrompts[type]],
      ["human", "{question}"]
    ]);
  
    return writingPrompt;
  }
  
  static async writing({ 
    question, 
    type = 'custom', 
    content 
  }: { 
    question: string, 
    type?: 'expand' | 'polish' | 'custom',
    content?: string 
  }) {
    try {
      const { LLM } = await AiModelFactory.GetProvider();
      const writingPrompt = AiService.getWritingPrompt(type, content);
      const writingChain = writingPrompt.pipe(LLM).pipe(new StringOutputParser());
      
      const result = await writingChain.stream({
        question,
        content: content || ''
      });
      
      return { result };
    } catch (error) {
      console.log(error);
      throw new Error(error);
    }
  }

  static async speechToText(audioPath: string) {
    const loader = await AiModelFactory.GetAudioLoader(audioPath)
    const docs = await loader.load();
    return docs
  }
}