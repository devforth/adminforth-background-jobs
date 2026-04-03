<template>
  <!-- Hidden component that registers a global function to open job info modal -->
  <div style="display:none">
    <Modal 
      ref="dialogRef" 
      removeFromDomOnClose 
      class="p-4"
      :beforeCloseFunction="() => { jobStore.clearCurrentJob(); jobStore.setIsOpened(false); }"
    >
      <JobInfoPopup
        v-if="jobStore.currentJob"
        :job="jobStore.currentJob"
        :meta="meta"
        :closeModal="closeModal"
      />
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { Modal } from '@/afcl';
import JobInfoPopup from './JobInfoPopup.vue';
import websocket from '@/websocket';
import { useBackgroundJobApi } from './useBackgroundJobApi';

const jobStore = useBackgroundJobApi();

const dialogRef = ref<any>(null);

const props = defineProps<{
  meta: {
    pluginInstanceId: string;
  }
}>();


function closeModal() {
  if (!dialogRef.value) return;
  if (typeof dialogRef.value.close === 'function') {
    dialogRef.value.close();
    jobStore.clearCurrentJob();
    jobStore.setIsOpened(false);
    return;
  }
  if (typeof dialogRef.value.hide === 'function') {
    jobStore.clearCurrentJob();
    jobStore.setIsOpened(false);
    dialogRef.value.hide();
  }
}

watch(() => jobStore.isOpened, (newVal) => {
  if (newVal) {
    dialogRef.value?.open?.();
  } else {
    dialogRef.value?.close?.();
  }
});

async function openJobInfo(jobId: string) {
  jobStore.openJobInfoPopup(jobId);
}


onMounted(() => {
  // expose global function
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  window.OpenJobInfoPopup = openJobInfo;

  websocket.subscribe('/background-jobs', (data) => {
    if (data.jobId === jobStore.currentJob?.id) {
      if (data.status) { 
        jobStore.updateCurrentJob({ status: data.status });
      }
      if (data.progress !== undefined) {
        jobStore.updateCurrentJob({ progress: data.progress });
      }
      if (data.finishedAt) {
        jobStore.updateCurrentJob({ finishedAt: data.finishedAt });
      }
      if (data.state) {
        jobStore.updateCurrentJob({ state: { ...jobStore.currentJob?.state, ...data.state } });
      }
    }
  });
});
onBeforeUnmount(() => {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (window.OpenJobInfoPopup) delete window.OpenJobInfoPopup;
  websocket.unsubscribe('/background-jobs');
});
</script>
