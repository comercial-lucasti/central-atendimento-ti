/**
 * Central de Atendimento de T.I — backend (Google Apps Script).
 *
 * Contrato com o front: processarChamado(dados) -> { sucesso, protocolo | erro, emailEnviado, anexoSalvo }
 *
 *  - LockService: protocolo único e sem chamados simultâneos embaralhados
 *  - Validação de campos, tipo e tamanho do anexo (5 MB)
 *  - Pasta de anexos criada automaticamente no Drive (ou informe o ID em CONFIG)
 *  - Falha de e-mail NÃO derruba o chamado já gravado (evita duplicidade por reenvio)
 *  - Cópia opcional do chamado para a equipe de T.I
 */

var CONFIG = {
  ABA: '',                 // nome da aba; vazio = primeira aba da planilha
  PASTA_ANEXOS_ID: '',     // ID de uma pasta existente. Vazio = cria e reutiliza a pasta 'Anexos - Suporte de T.I'
  EMAIL_TI: '',            // e-mail(s) da equipe de T.I que recebem cópia de cada chamado (separe por vírgula)
  EMAIL_DIRETORIA: '',     // opcional: e-mail(s) de acompanhamento da gestão
  TAMANHO_MAX: 5 * 1024 * 1024,
  TIPOS: {
    'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
  },
  MIME_POR_EXT: {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Central de Atendimento - Suporte de T.I')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function processarChamado(dados) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (e) {
    return { sucesso: false, erro: 'Sistema ocupado. Tente novamente em instantes.' };
  }

  try {
    var erroVal = validar_(dados);
    if (erroVal) return { sucesso: false, erro: erroVal };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var planilha = CONFIG.ABA ? (ss.getSheetByName(CONFIG.ABA) || ss.insertSheet(CONFIG.ABA)) : ss.getSheets()[0];

    // Protocolo (mesmo formato de antes). Sob trava, evita repetir o do chamado anterior.
    var props = PropertiesService.getScriptProperties();
    var data = new Date();
    var protocolo = gerarProtocolo_(data);
    if (protocolo === props.getProperty('ULTIMO_PROTOCOLO')) {
      Utilities.sleep(1100);
      data = new Date();
      protocolo = gerarProtocolo_(data);
    }

    // Anexo: se falhar, NADA é registrado e o usuário recebe o erro.
    var linkAnexo = 'Sem anexo';
    var anexoSalvo = null;
    if (dados.arquivo && dados.arquivo.bytes) {
      try {
        linkAnexo = salvarAnexo_(dados.arquivo, protocolo);
        anexoSalvo = true;
      } catch (e) {
        return { sucesso: false, erro: 'Falha ao salvar o anexo: ' + e.message };
      }
    }

    // Registro (mesmas 11 colunas, na mesma ordem)
    planilha.appendRow([
      protocolo, data,
      seguro_(dados.email), seguro_(dados.nome), seguro_(dados.setor), seguro_(dados.tipoOcorrencia),
      seguro_(dados.categoria), seguro_(dados.impacto), seguro_(dados.urgencia), seguro_(dados.descricao),
      linkAnexo
    ]);
    SpreadsheetApp.flush();
    props.setProperty('ULTIMO_PROTOCOLO', protocolo);

    // E-mails: falha aqui não cancela o chamado (já está gravado).
    var emailEnviado = true;
    try {
      enviarEmails_(protocolo, dados, linkAnexo);
    } catch (e) {
      emailEnviado = false;
      console.error('Falha no e-mail do protocolo ' + protocolo + ': ' + e);
    }

    return { sucesso: true, protocolo: protocolo, emailEnviado: emailEnviado, anexoSalvo: anexoSalvo };
  } catch (erro) {
    console.error(erro);
    return { sucesso: false, erro: erro.toString() };
  } finally {
    lock.releaseLock();
  }
}

function gerarProtocolo_(data) {
  return 'TI-' + Utilities.formatDate(data, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
}

function validar_(d) {
  if (!d) return 'Dados não recebidos.';
  var obrig = ['email', 'nome', 'setor', 'tipoOcorrencia', 'categoria', 'impacto', 'urgencia', 'descricao'];
  for (var i = 0; i < obrig.length; i++) {
    if (!d[obrig[i]] || !String(d[obrig[i]]).trim()) return 'Campo obrigatório ausente: ' + obrig[i];
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email).trim())) return 'E-mail inválido.';
  if (String(d.descricao).length > 5000) return 'Descrição muito longa (máx. 5000 caracteres).';
  return '';
}

// Impede que texto começando com = + - @ seja interpretado como fórmula na planilha.
function seguro_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function salvarAnexo_(arq, protocolo) {
  var nome = String(arq.nome || 'anexo');
  var ext = (nome.split('.').pop() || '').toLowerCase();
  var mime = arq.mimeType && CONFIG.TIPOS[arq.mimeType] ? arq.mimeType : CONFIG.MIME_POR_EXT[ext];
  if (!mime) throw new Error('tipo de arquivo não permitido (use PNG, JPG, PDF, DOC ou DOCX).');
  var bytes = Utilities.base64Decode(arq.bytes);
  if (!bytes.length) throw new Error('arquivo vazio.');
  if (bytes.length > CONFIG.TAMANHO_MAX) throw new Error('arquivo maior que 5 MB.');
  var nomeSeguro = nome.replace(/[^\w.\-() ]+/g, '_').slice(0, 80);
  var blob = Utilities.newBlob(bytes, mime, protocolo + '_' + nomeSeguro);
  var pasta = pastaAnexos_();
  return pasta.createFile(blob).getUrl();
}

function enviarEmails_(protocolo, dados, linkAnexo) {
  var assunto = 'Suporte de T.I Registrado - Protocolo: ' + protocolo;
  var mensagem = 'Olá, ' + dados.nome + '!\n\n' +
    'Sua solicitação de suporte de T.I foi registrada com sucesso.\n\n' +
    '📌 Número de Protocolo: ' + protocolo + '\n' +
    '🏢 Setor: ' + dados.setor + '\n' +
    '⚠️ Urgência: ' + dados.urgencia + '\n\n' +
    'Lembre-se: Todas as tratativas ocorrem respondendo a este e-mail.\n\n' +
    'Atenciosamente,\n' +
    'Equipe de Suporte de T.I';
  MailApp.sendEmail(dados.email, assunto, mensagem);

  var copia = [CONFIG.EMAIL_TI, CONFIG.EMAIL_DIRETORIA].filter(String).join(',');
  if (copia) {
    MailApp.sendEmail({
      to: copia,
      replyTo: dados.email,
      subject: '[Chamado T.I ' + protocolo + '] ' + dados.urgencia + ' — ' + dados.setor + ' — ' + dados.tipoOcorrencia,
      body: 'Protocolo: ' + protocolo + '\nNome: ' + dados.nome + '\nE-mail: ' + dados.email +
        '\nSetor: ' + dados.setor + '\nTipo: ' + dados.tipoOcorrencia + '\nCategoria: ' + dados.categoria +
        '\nImpacto: ' + dados.impacto + '\nUrgência: ' + dados.urgencia +
        '\n\nDescrição:\n' + dados.descricao + '\n\nAnexo: ' + linkAnexo
    });
  }
}

// Pasta de anexos: usa CONFIG.PASTA_ANEXOS_ID; se vazio, cria uma vez e guarda o ID.
function pastaAnexos_() {
  if (CONFIG.PASTA_ANEXOS_ID) return DriveApp.getFolderById(CONFIG.PASTA_ANEXOS_ID);
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PASTA_ANEXOS_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var pasta = DriveApp.createFolder('Anexos - Suporte de T.I');
  props.setProperty('PASTA_ANEXOS_ID', pasta.getId());
  return pasta;
}
